// company_directory.js
// Curated starter list with proper domains for logo fetching
// Add more companies by pasting a Greenhouse board URL/slug (auto-verifies) or any careers URL (saved as link-only).

window.COMPANY_DIRECTORY = [
  // ===== Big Tech (Greenhouse) =====
  { id: "stripe", name: "Stripe", provider: "greenhouse", boardSlug: "stripe", domain: "stripe.com", careersUrl: "https://boards.greenhouse.io/stripe" },
  { id: "airbnb", name: "Airbnb", provider: "greenhouse", boardSlug: "airbnb", domain: "airbnb.com", careersUrl: "https://boards.greenhouse.io/airbnb" },
  { id: "doordash", name: "DoorDash", provider: "greenhouse", boardSlug: "doordash", domain: "doordash.com", careersUrl: "https://boards.greenhouse.io/doordash" },
  { id: "figma", name: "Figma", provider: "greenhouse", boardSlug: "figma", domain: "figma.com", careersUrl: "https://boards.greenhouse.io/figma" },
  { id: "coinbase", name: "Coinbase", provider: "greenhouse", boardSlug: "coinbase", domain: "coinbase.com", careersUrl: "https://boards.greenhouse.io/coinbase" },
  { id: "twitch", name: "Twitch", provider: "greenhouse", boardSlug: "twitch", domain: "twitch.tv", careersUrl: "https://boards.greenhouse.io/twitch" },
  { id: "roblox", name: "Roblox", provider: "greenhouse", boardSlug: "roblox", domain: "roblox.com", careersUrl: "https://boards.greenhouse.io/roblox" },
  { id: "databricks", name: "Databricks", provider: "greenhouse", boardSlug: "databricks", domain: "databricks.com", careersUrl: "https://boards.greenhouse.io/databricks" },
  { id: "notion", name: "Notion", provider: "greenhouse", boardSlug: "notion", domain: "notion.so", careersUrl: "https://boards.greenhouse.io/notion" },
  { id: "snowflake", name: "Snowflake", provider: "greenhouse", boardSlug: "snowflake", domain: "snowflake.com", careersUrl: "https://boards.greenhouse.io/snowflake" },
  { id: "shopify", name: "Shopify", provider: "greenhouse", boardSlug: "shopify", domain: "shopify.com", careersUrl: "https://boards.greenhouse.io/shopify" },
  { id: "airtable", name: "Airtable", provider: "greenhouse", boardSlug: "airtable", domain: "airtable.com", careersUrl: "https://boards.greenhouse.io/airtable" },
  { id: "discord", name: "Discord", provider: "greenhouse", boardSlug: "discord", domain: "discord.com", careersUrl: "https://boards.greenhouse.io/discord" },
  { id: "robinhood", name: "Robinhood", provider: "greenhouse", boardSlug: "robinhood", domain: "robinhood.com", careersUrl: "https://boards.greenhouse.io/robinhood" },
  { id: "atlassian", name: "Atlassian", provider: "greenhouse", boardSlug: "atlassian", domain: "atlassian.com", careersUrl: "https://boards.greenhouse.io/atlassian" },

  // ===== FAANG+ (Custom - Manual careers pages) =====
  // These companies don't use Greenhouse, so we link directly to their careers pages
  { id: "custom:google.com", name: "Google", provider: "custom", domain: "google.com", careersUrl: "https://careers.google.com/" },
  { id: "custom:meta.com", name: "Meta", provider: "custom", domain: "meta.com", careersUrl: "https://www.metacareers.com/" },
  { id: "custom:amazon.com", name: "Amazon", provider: "custom", domain: "amazon.com", careersUrl: "https://www.amazon.jobs/" },
  { id: "custom:apple.com", name: "Apple", provider: "custom", domain: "apple.com", careersUrl: "https://www.apple.com/careers/" },
  { id: "custom:netflix.com", name: "Netflix", provider: "custom", domain: "netflix.com", careersUrl: "https://jobs.netflix.com/" },
  { id: "custom:microsoft.com", name: "Microsoft", provider: "custom", domain: "microsoft.com", careersUrl: "https://careers.microsoft.com/" },
  { id: "custom:nvidia.com", name: "NVIDIA", provider: "custom", domain: "nvidia.com", careersUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite" },
  { id: "custom:salesforce.com", name: "Salesforce", provider: "custom", domain: "salesforce.com", careersUrl: "https://www.salesforce.com/company/careers/" },
  { id: "custom:tesla.com", name: "Tesla", provider: "custom", domain: "tesla.com", careersUrl: "https://www.tesla.com/careers" },
  { id: "custom:openai.com", name: "OpenAI", provider: "custom", domain: "openai.com", careersUrl: "https://openai.com/careers/" },
  { id: "custom:anthropic.com", name: "Anthropic", provider: "custom", domain: "anthropic.com", careersUrl: "https://www.anthropic.com/careers" },

  // ===== Lever Companies (Coming Next) =====
  { id: "lever:reddit", name: "Reddit", provider: "lever", boardSlug: "reddit", domain: "reddit.com", careersUrl: "https://jobs.lever.co/reddit" },
  { id: "lever:plaid", name: "Plaid", provider: "lever", boardSlug: "plaid", domain: "plaid.com", careersUrl: "https://jobs.lever.co/plaid" },
];