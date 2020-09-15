import _ from 'lodash';
import * as ynab from 'ynab';
import moment from 'moment/moment';
import {
  EnrichedTransaction, OutputVendor, OutputVendorName, ExportTransactionsFunction
} from '@/originalBudgetTrackingApp/commonTypes';
import { BudgetTrackingEventEmitter, EventNames } from '@/originalBudgetTrackingApp/eventEmitters/EventEmitter';
import { Config, YnabConfig } from '../../../configManager/configManager';

const INITIAL_YNAB_ACCESS_TOKEN = 'AABB';
const YNAB_DATE_FORMAT = 'YYYY-MM-DD';
const NOW = moment();

type YnabFinancialAccount = Pick<ynab.Account, 'id' | 'name' | 'type'> & { budgetName: string };

interface YnabAccountDetails {
  budgets: ynab.BudgetSummary[];
  accounts: YnabFinancialAccount[];
  categories: string[]
}

const categoriesMap: Map<string, Pick<ynab.Category, 'id' | 'name' | 'category_group_id'>> = new Map();
const transactionsFromYnab: Map<Date, ynab.TransactionDetail[]> = new Map();

let ynabConfig: YnabConfig | undefined;
let ynabAPI: ynab.API | undefined;
let ynabAccountDetails: YnabAccountDetails | undefined;

export async function init(outputVendorsConfig: Config['outputVendors']) {
  if (ynabConfig && ynabAPI) {
    return;
  }

  ynabConfig = outputVendorsConfig.ynab;

  if (!ynabConfig?.active) {
    return;
  }
  verifyYnabAccessTokenWasDefined();
  ynabAPI = new ynab.API(ynabConfig.options.accessToken);
}

const createTransactions: ExportTransactionsFunction = async ({ transactionsToCreate, startDate }, eventEmitter) => {
  if (!ynabConfig) {
    throw new Error('Must call init before using ynab functions');
  }
  if (!categoriesMap.size) {
    await initCategories();
  }
  const transactionsFromFinancialAccount = transactionsToCreate.map(convertTransactionToYnabFormat);
  let transactionsThatDontExistInYnab = await filterOnlyTransactionsThatDontExistInYnabAlready(startDate, transactionsFromFinancialAccount);
  // Filter out transactions that are in the future
  transactionsThatDontExistInYnab = transactionsThatDontExistInYnab.filter((transaction) => moment(transaction.date, YNAB_DATE_FORMAT).isBefore(NOW));
  if (!transactionsThatDontExistInYnab.length) {
    await emitProgressEvent(eventEmitter, transactionsToCreate, 'All transactions already exist in ynab. Doing nothing.');
    return null;
  }
  await emitProgressEvent(eventEmitter, transactionsToCreate, `Creating ${transactionsThatDontExistInYnab.length} transactions in ynab`);
  try {
    const transactionCreationResult = await ynabAPI!.transactions.createTransactions(ynabConfig.options.budgetId, {
      transactions: transactionsThatDontExistInYnab
    });
    return transactionCreationResult;
  } catch (e) {
    await eventEmitter.emit(EventNames.EXPORTER_ERROR, { name: ynabOutputVendor.name, allTransactions: transactionsToCreate, error: e });
    throw e;
  }
};

function getTransactions(startDate: Date): Promise<ynab.TransactionsResponse> {
  return ynabAPI!.transactions.getTransactions(ynabConfig!.options.budgetId, moment(startDate).format(YNAB_DATE_FORMAT));
}

function convertTransactionToYnabFormat(originalTransaction: EnrichedTransaction): ynab.SaveTransaction {
  const payeeNameMaxLength = ynabConfig!.options.maxPayeeNameLength || 50;
  const amount = Math.round(originalTransaction.chargedAmount * 1000);
  const date = convertTimestampToYnabDateFormat(originalTransaction);
  return {
    account_id: getYnabAccountIdByAccountNumberFromTransaction(originalTransaction.accountNumber),
    date, // "2019-01-17",
    amount,
    // "payee_id": "string",
    payee_name: originalTransaction.description.substring(0, payeeNameMaxLength),
    category_id: getYnabCategoryIdFromCategoryName(originalTransaction.category),
    memo: originalTransaction.memo,
    cleared: ynab.SaveTransaction.ClearedEnum.Cleared
    // "approved": true,
    // "flag_color": "red",
    // "import_id": buildImportId(originalTransaction.description, amount, date) // 'YNAB:[milliunit_amount]:[iso_date]:[occurrence]'
  };
}

function getYnabAccountIdByAccountNumberFromTransaction(transactionAccountNumber: string) : string {
  const ynabAccountId = ynabConfig!.options.accountNumbersToYnabAccountIds[transactionAccountNumber];
  if (!ynabAccountId) {
    throw new Error(`Unhandled account number ${transactionAccountNumber}`);
  }
  return ynabAccountId;
}

function convertTimestampToYnabDateFormat(originalTransaction: EnrichedTransaction): string {
  return moment(originalTransaction.date).format(YNAB_DATE_FORMAT); // 2018-12-29T22:00:00.000Z -> 2018-12-29
}

function getYnabCategoryIdFromCategoryName(categoryName?: string) {
  if (!categoryName) {
    return null;
  }
  const categoryToReturn = categoriesMap.get(categoryName);
  if (!categoryToReturn) {
    const errorMessage = `No category for name ${categoryName}`;
    throw new Error(errorMessage);
  }
  return categoryToReturn && categoryToReturn.id;
}

export async function initCategories() {
  const categories = await ynabAPI!.categories.getCategories(ynabConfig!.options.budgetId);
  categories.data.category_groups.forEach((categoryGroup) => {
    categoryGroup.categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        category_group_id: category.category_group_id
      }))
      .forEach((category) => {
        categoriesMap.set(category.name, category);
      });
  });
}

async function filterOnlyTransactionsThatDontExistInYnabAlready(startDate: Date, transactionsFromFinancialAccounts: ynab.SaveTransaction[]) {
  let transactionsInYnabBeforeCreatingTheseTransactions: ynab.TransactionDetail[];
  if (transactionsFromYnab.has(startDate)) {
    // @ts-ignore
    transactionsInYnabBeforeCreatingTheseTransactions = transactionsFromYnab.get(startDate);
  } else {
    const transactionsFromYnabResponse = await getTransactions(startDate);
    transactionsInYnabBeforeCreatingTheseTransactions = transactionsFromYnabResponse.data.transactions;
    transactionsFromYnab.set(startDate, transactionsInYnabBeforeCreatingTheseTransactions);
  }
  const transactionsThatDontExistInYnab = transactionsFromFinancialAccounts.filter(
    (transactionToCheck) => !transactionsInYnabBeforeCreatingTheseTransactions.find(
      (existingTransaction) => isSameTransaction(transactionToCheck, existingTransaction)
    )
  );
  return transactionsThatDontExistInYnab;
}

export function isSameTransaction(transactionToCreate: ynab.SaveTransaction, transactionFromYnab: ynab.TransactionDetail) {
  const isATransferTransaction = !!transactionFromYnab.transfer_account_id;
  return (
    transactionToCreate.account_id === transactionFromYnab.account_id
    && transactionToCreate.date === transactionFromYnab.date
    && Math.abs(transactionToCreate.amount - transactionFromYnab.amount) < 1000
    // In a transfer transaction the payee name changes, but we still consider this the same transaction
    && (areStringsEqualIgnoreCaseAndWhitespace(transactionToCreate.payee_name, transactionFromYnab.payee_name) || isATransferTransaction)
  );
}

export function areStringsEqualIgnoreCaseAndWhitespace(str1: string | null | undefined = '', str2 : string | null | undefined = '') {
  const trimmedAndLowerCaseStr1 = str1 && normalizeWhitespace(str1.toLowerCase());
  const trimmedAndLowerCaseStr2 = str2 && normalizeWhitespace(str2.toLowerCase());

  return trimmedAndLowerCaseStr1 === trimmedAndLowerCaseStr2;
}

function normalizeWhitespace(str: string) {
  return str && str.trim().replace(/\s+/g, ' ');
}

function verifyYnabAccessTokenWasDefined() {
  if (ynabConfig!.options.accessToken === INITIAL_YNAB_ACCESS_TOKEN) {
    throw new Error('You need to set the ynab access token in the config');
  }
}

export async function getYnabAccountDetails(outputVendorsConfig: Config['outputVendors']): Promise<YnabAccountDetails> {
  if (!ynabAccountDetails) {
    await init(outputVendorsConfig);
    const { budgets, accounts } = await getBudgetsAndAccountsData();
    const categoryNames = await getYnabCategories();
    ynabAccountDetails = {
      budgets,
      accounts,
      categories: categoryNames
    };
  }
  return ynabAccountDetails;
}

async function getBudgetsAndAccountsData() {
  const budgetsResponse = await ynabAPI!.budgets.getBudgets();
  let { budgets } = budgetsResponse.data;
  budgets = budgets.map((budget) => ({ id: budget.id, name: budget.name }));
  const accounts: YnabFinancialAccount[] = [];
  await Promise.all(
    budgets.map(async (budget) => {
      const budgetAccountsResponse = await ynabAPI!.accounts.getAccounts(budget.id);
      const budgetAccounts = budgetAccountsResponse.data.accounts.map(({ id, name, type }) => ({
        id, name, type, budgetName: budget.name
      }));
      accounts.push(...budgetAccounts);
    })
  );
  return {
    budgets,
    accounts
  };
}

async function getYnabCategories() {
  const categoriesResponse = await ynabAPI!.categories.getCategories(ynabConfig!.options.budgetId);
  const categories = _.flatMap(categoriesResponse.data.category_groups, (categoryGroup) => categoryGroup.categories);
  const categoryNames = categories.map((category) => category.name);
  return categoryNames;
}

async function emitProgressEvent(eventEmitter: BudgetTrackingEventEmitter, allTransactions: EnrichedTransaction[], message: string) {
  await eventEmitter.emit(EventNames.EXPORTER_PROGRESS, { name: ynabOutputVendor.name, allTransactions, message });
}

export const ynabOutputVendor: OutputVendor = {
  name: OutputVendorName.YNAB,
  init,
  exportTransactions: createTransactions
};
