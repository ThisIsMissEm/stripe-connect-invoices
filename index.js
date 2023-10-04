import Stripe from "stripe";
import prompts from "prompts";
import ora from "ora";

import { getMonthChoices, formatPeriod } from "./src/date-fns.js";

function getStripeClients() {
  const clients = {};

  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("STRIPE_TOKEN_")) {
      const account = key.slice(13).toLowerCase();
      const secret = process.env[key];

      if (!secret) return;

      const client = new Stripe(secret, {
        apiVersion: "2023-08-16",
      });

      clients[account] = client;
    }
  });

  const accounts = Object.keys(clients);

  return [clients, accounts];
}

// Turns out the strip API client supports async iterators and I didn't need to
// write one, I just missed it in the documentation
//
// async function* balanceTransactions(client, period, sinceId) { const
//   transactions = await client.balanceTransactions.list({ created: { gte:
//   Math.floor(period.start.valueOf() / 1000), lte:
//   Math.ceil(period.end.valueOf() / 1000),
//     },
//     starting_after: sinceId ?? undefined,
//     expand: ["data.source"],
//   });
//
//   for (const tx of transactions.data) {
//     yield tx;
//   }
//
//   if (transactions.has_more) {
//     yield* balanceTransactions(client, period, transactions.data.at(-1).id);
//   }
// }

async function main() {
  // 1. Fetch all STRIPE_TOKEN_XXXX environment variables
  const [stripeClients, stripeAccounts] = getStripeClients();

  if (stripeAccounts.length < 1) {
    console.log(
      "No stripe credentials found, please make sure you set them in .env as STRIPE_TOKEN_[name]\nIf you're using 1password, make sure the credential has a value."
    );
    process.exit(1);
  }

  // 2. Prompt for which account and time period to fetch data for:
  const responses = await prompts([
    {
      type: "select",
      name: "account",
      message: "Please select which Stripe account to use:",
      choices: stripeAccounts.sort().map((account) => ({
        title: account,
        value: account,
      })),
    },
    {
      type: "select",
      name: "period",
      message: "Select the period to create query for?",
      choices: getMonthChoices(),
    },
  ]);

  console.log(
    `\nOkay we'll fetch from ${responses.account} for ${formatPeriod(
      responses.period
    )}\n`
  );

  const spinner = ora({
    text: "Fetching transactions...",
    spinner: "bouncingBar",
    color: "yellow",
  }).start();

  const stripeClient = stripeClients[responses.account];

  const taxesAndFees = {
    tax: [],
    stripe_fee: [],
    application_fee: [],
  };

  const payouts = [];
  const transactions = [];
  const charges = [];

  const totals = {
    pending_transactions: 0,
    payouts_gross: 0,
    payouts_net: 0,
    payouts_fees: 0,
    stripe_fees: 0,
    charge_gross: 0,
    charge_net: 0,
    charge_fees: 0,
    charge_stripe_fees: 0,
    charge_application_fees: 0,
    charge_tax_fees: 0,
  };

  const knownTransactionTypes = ["charge", "payout", "stripe_fee"];

  for await (const transaction of stripeClient.balanceTransactions.list({
    created: {
      gte: responses.period.start.valueOf() / 1000,
      lte: responses.period.end.valueOf() / 1000,
    },
    expand: ["data.source"],
  })) {
    // ignore pending transactions, but record a count:
    if (transaction.status === "pending") {
      totals.pending_transactions++;
      continue;
    }

    // ignore other transaction status, but log:
    if (transaction.status !== "available") {
      console.error(transaction);
      continue;
    }

    // Log for unhandled transaction types:
    if (!knownTransactionTypes.includes(transaction.type)) {
      spinner.warn(
        `Unknown transaction type: ${transaction.type}, id: ${transaction.id}`
      );
      continue;
    }

    // Calculate data:
    if (transaction.type === "stripe_fee") {
      totals.stripe_fees += transaction.amount * -1;
    }

    if (transaction.type === "payout") {
      // Payouts are negative, but I expect the fees to be positive on them:
      totals.payouts_gross += transaction.amount * -1;
      totals.payouts_net += transaction.net * -1;
      totals.payouts_fees += transaction.fee;

      payouts.push({
        transaction_id: transaction.id,
        id: transaction.source.id,
        amount: transaction.amount,
        fee: transaction.fee,
        currency: transaction.currency,
        status: transaction.status,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
        arrival_date: new Date(transaction.source.available_on * 1000),
      });
    }

    if (transaction.type === "charge") {
      // Calculate individual fee type totals:
      transaction.fee_details.forEach((fee) => {
        if (fee.type === "stripe_fee") {
          totals.charge_stripe_fees += fee.amount;
        } else if (fee.type === "application_fee") {
          totals.charge_application_fees += fee.amount;
        } else {
          totals.charge_tax_fees += fee.amount;
        }

        taxesAndFees[fee.type].push({
          transaction_id: transaction.id,
          charge_id: transaction.source.id,
          amount: fee.amount,
          currency: fee.currency,
          description: fee.description,
          created: new Date(transaction.created * 1000),
          available_on: new Date(transaction.available_on * 1000),
        });
      });

      charges.push({
        transaction_id: transaction.id,
        id: transaction.source.id,
        amount: transaction.amount,
        fee: transaction.fee,
        currency: transaction.currency,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
        metadata: transaction.source.metadata,
        payment_method: transaction.source.payment_method_details,
        billing_details: transaction.source.billing_details,
      });

      totals.charge_fees += transaction.fee;
      totals.charge_gross += transaction.amount;
      totals.charge_net += transaction.net;
    }

    transactions.push(transaction);
  }

  spinner.succeed();
  console.log("\n");
  console.log(taxesAndFees);
  console.log(totals);
}

main()
  .then(() => {
    console.log("\nok");
    process.exit(0);
  })
  .catch((error) => {
    if (error.message.startsWith("User force closed the prompt with")) {
      console.log("\nBye!");
      process.exit(0);
    } else {
      console.error("\n");
      console.error(error);
      process.exit(1);
    }
  });