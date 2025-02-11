import prompts from "prompts";
import op from "@1password/op-js";

import configuration from "../src/configuration.js";
import { getMonthChoices, formatPeriod } from "../src/date-fns.js";
import { getStripeClient, getStripeTokens } from "../src/stripe.js";

import downloadInvoices from "../src/actions/downloadInvoices.js";
import createAndSaveReceipts from "../src/actions/createAndSaveReceipts.js";
import savePayoutReceipts from "../src/actions/savePayoutReceipts.js";
import { debug } from "../src/utils.js";

async function main() {
  // 1. Fetch all STRIPE_TOKEN_XXXX environment variables
  const stripeTokens = getStripeTokens();
  const config = configuration.getProperties();

  if (stripeTokens.size < 1) {
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
      choices: Array.from(stripeTokens.keys()).map((account) => ({
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
    {
      type: "select",
      name: "action",
      message: "What would you like to do?",
      choices: [
        {
          title: "Create & Save Receipts",
          description:
            "Creates a PDF receipt for each charge on the Stripe account",
          value: "createAndSaveReceipts",
        },
        {
          title: "Download Invoices",
          description: "Downloads invoices generated by Stripe",
          value: "downloadInvoices",
        },
        {
          title: "Save Payout Receipts",
          description:
            "Retrieves each payout for the given period and generates a PDF receipt for the payout and the transactions involved",
          value: "savePayoutReceipts",
        },
      ],
    },
  ]);

  if (!responses.account || !responses.period || !responses.action) {
    console.log("\nInterrupted, okay, bye!");
    return process.exit(0);
  }

  const accountName = responses.account;
  const token = stripeTokens.get(accountName);
  if (!token) {
    console.log("\nFailed to find Stripe token?");
    return process.exit(0);
  }

  let secret = token;
  if (token.startsWith("op://")) {
    secret = op.read.parse(token);
  }

  const stripe = getStripeClient(secret);

  console.log(
    `\nOkay processing ${responses.account} for ${formatPeriod(
      responses.period
    )}\n`
  );

  if (process.env.NODE_DEBUG?.includes("stripe")) {
    stripe.on("request", (event) => {
      debug("stripe.request", event);
    });
  }

  switch (responses.action) {
    case "createAndSaveReceipts":
      await createAndSaveReceipts(
        stripe,
        responses.account,
        responses.period,
        config
      );
      break;
    case "downloadInvoices":
      await downloadInvoices(
        stripe,
        responses.account,
        responses.period,
        config
      );
      break;
    case "savePayoutReceipts":
      await savePayoutReceipts(
        stripe,
        responses.account,
        responses.period,
        config
      );
      break;
    default:
      throw new Error(`Unhandled command: ${responses.action}`);
  }
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
