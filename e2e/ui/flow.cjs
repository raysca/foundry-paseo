// Drives the Shout scenario through Foundry's screens in Paseo's web app, against the e2e daemon with
// the scripted harness. Usage: node e2e/ui/flow.cjs <web-ui-url> <screenshot-dir>
const { chromium } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:6790/";
const OUT = process.argv[3] || "/tmp/foundry-ui";
require("fs").mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  let n = 0;
  const shot = async (name) => p.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
  const main = () => p.locator("body");
  const see = async (text, timeout = 120000) => {
    // Paseo keeps earlier screens mounted but hidden, so only visible text counts.
    await main().getByText(text, { exact: false }).locator("visible=true").first().waitFor({ timeout });
  };
  const press = async (text, exact = true) => {
    const el = p.getByRole("button", { name: text, exact }).locator("visible=true").first();
    await el.waitFor({ timeout: 120000 });
    await el.click();
  };
  const step = async (name, fn) => {
    log(name);
    try {
      await fn();
    } catch (e) {
      await shot(`FAILED-${name.replace(/\W+/g, "-")}`);
      console.log((await main().innerText()).slice(0, 3000));
      throw e;
    }
  };

  await step("open Foundry from the sidebar", async () => {
    await p.goto(URL, { waitUntil: "networkidle" });
    // Paseo's first-run welcome sheet, on a fresh daemon home.
    const skip = p.getByText("Skip setup");
    await skip.waitFor({ timeout: 8000 }).then(() => skip.click(), () => {});
    await p.waitForTimeout(500);
    await p.getByText("Foundry", { exact: true }).first().click();
    await see("New feature");
    await shot("home");
  });

  await step("create a feature", async () => {
    await press("New feature");
    await p.getByPlaceholder("Shout mode", { exact: false }).fill("Shout mode\nLet the CLI shout its input.");
    await press("Create");
    await see("Clarify: 1 question");
    await shot("clarify");
  });

  await step("answer Clarify with the recommendation", async () => {
    await press("Send answers");
    await see("Approve spec.md at");
    await shot("spec");
  });

  await step("approve the spec", async () => {
    await press(/^Approve spec\.md at/, false);
    await see("Approve plan.md at");
  });

  await step("approve the plan", async () => {
    await press(/^Approve plan\.md at/, false);
    await see("Approve tasks.md at");
    await shot("tasks");
  });

  await step("approve the task list", async () => {
    await press(/^Approve tasks\.md at/, false);
    await see("Build", 30000);
  });

  for (const key of ["SHT-1", "SHT-2"]) {
    await step(`review and accept ${key}`, async () => {
      // Back to the feature, then into the task once it waits on review.
      await p.getByText(key, { exact: true }).locator("visible=true").first().click();
      if (key === "SHT-2") {
        // The scripted builder asks whether -s works too; the answer resumes its session.
        await see("Waiting on your answer", 240000);
        await shot("question");
        await p.getByPlaceholder("Your answer").locator("visible=true").first().fill("yes, -s too");
        await press("Answer");
      }
      await see("Your review", 240000);
      await see("Changes against the feature branch");
      await shot(`review-${key}`);
      await press(/^Accept /, false);
      await see("Done", 60000);
      await p.getByText("Shout mode", { exact: true }).locator("visible=true").first().click();
    });
  }

  await step("Verify fails a check; ship with the gap", async () => {
    await see("Ship with the gaps", 240000);
    await shot("verify");
    await press("Ship with the gaps");
    await press("Prepare the ship");
    await see("Ship by local merge");
  });

  await step("ship, confirming the merge into the checked-out main", async () => {
    await press(/^Ship [0-9a-f]{7}$/, false);
    await see("Merge there anyway");
    await shot("ship-confirm");
    await press("Merge there anyway");
    await see("Shipped.", 60000);
    await shot("shipped");
  });

  await step("ask the project manager", async () => {
    await press("Ask the project manager");
    await p.getByPlaceholder("Ask about progress", { exact: false }).fill("Where are we?");
    await press("Send");
    await see("Project manager ·", 120000);
    await shot("pm");
  });

  if (errors.length) {
    console.log("page errors:\n" + errors.join("\n"));
    process.exit(1);
  }
  log("UI flow passed");
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
