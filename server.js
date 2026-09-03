
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as actual from "@actual-app/api";
import { probeTransaction, importCandidate, getMatchCandidates, canImportSeparately, importSeparateCandidate } from "./import-reconciliation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(__dirname, "package.json"), "utf8")
);
const IMPORTER_VERSION = packageMetadata.version;
const CONFIGURED_ACTUAL_API_VERSION =
  packageMetadata.dependencies?.["@actual-app/api"] || "unknown";
let ACTUAL_API_VERSION = CONFIGURED_ACTUAL_API_VERSION;

try {
  const installedActualMetadata = JSON.parse(
    await fs.readFile(
      path.join(__dirname, "node_modules", "@actual-app", "api", "package.json"),
      "utf8"
    )
  );
  ACTUAL_API_VERSION = installedActualMetadata.version || ACTUAL_API_VERSION;
} catch {
  // package.json is still the source of truth before dependencies are installed.
}
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const PROFILE_DIR = path.join(DATA_DIR, "profiles");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ACTUAL_CACHE = process.env.ACTUAL_CACHE_DIR || "/tmp/actual-budget-csv-importer";
const ACTUAL_CACHE_IDLE_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.ACTUAL_CACHE_IDLE_MINUTES || "20", 10) || 20
);
const ACTUAL_CACHE_IDLE_MS = ACTUAL_CACHE_IDLE_MINUTES * 60 * 1000;
let actualCacheLastUsedAt = 0;
let actualCacheCleanupInProgress = false;

function touchActualCache() {
  actualCacheLastUsedAt = Date.now();
}

async function clearActualCache(reason = "idle timeout") {
  if (actualCacheCleanupInProgress) return;
  actualCacheCleanupInProgress = true;
  try {
    await fs.rm(ACTUAL_CACHE, { recursive: true, force: true });
    actualCacheLastUsedAt = 0;
    console.log(`[Actual cache] Cleared: ${reason}`);
  } catch (error) {
    console.error("[Actual cache] Cleanup failed:", error);
  } finally {
    actualCacheCleanupInProgress = false;
  }
}

setInterval(async () => {
  if (actualCacheLastUsedAt &&
      Date.now() - actualCacheLastUsedAt >= ACTUAL_CACHE_IDLE_MS) {
    await clearActualCache(`${ACTUAL_CACHE_IDLE_MINUTES} minute(s) idle`);
  }
}, 30 * 1000).unref();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const clean = v => String(v ?? "").replace(/^\uFEFF/, "").trim();
const safeId = v => clean(v)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 80);

async function ensureData() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  await fs.mkdir(ACTUAL_CACHE, { recursive: true });
  try {
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        actual: {
          serverURL: "",
          syncId: "",
          budgetName: "",
          password: "",
          encryptionPassword: "",
          accountMappings: {}
        }
      }, null, 2),
      { mode: 0o600 }
    );
  }
}

async function readSettings() {
  await ensureData();
  return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
}

async function writeSettings(settings) {
  await fs.writeFile(
    SETTINGS_FILE,
    JSON.stringify(settings, null, 2),
    { mode: 0o600 }
  );
  try { await fs.chmod(SETTINGS_FILE, 0o600); } catch {}
}

function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer);
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let odd = 0, even = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) (i % 2 ? odd++ : even++);
  }
  const pairs = Math.max(1, Math.floor(sample.length / 2));

  if (odd / pairs > 0.25 && odd > even * 3) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (even / pairs > 0.25 && even > odd * 3) {
    return new TextDecoder("utf-16be").decode(buffer);
  }
  return new TextDecoder("utf-8").decode(buffer);
}

function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];

    if (quoted) {
      if (c === '"' && n === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(r => r.some(x => clean(x)));
}

function parseMoney(value) {
  let s = clean(value).replace(/[$£€,\s]/g, "");
  if (!s) return null;
  const parentheses = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (parentheses ? -n : n) : null;
}

function parseDate(value, format) {
  const s = clean(value);
  let m;
  if (!s) return null;

  if (format === "YYYY-MM-DD" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (format === "YYYYMMDD" && /^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }

  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
    jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
  };

  if (format === "DD MMM YYYY" &&
      (m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/))) {
    const mo = months[m[2].toLowerCase()];
    return mo
      ? `${m[3]}-${String(mo).padStart(2,"0")}-${String(+m[1]).padStart(2,"0")}`
      : null;
  }

  if (format === "MM/DD/YYYY" &&
      (m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  }

  if (format === "DD/MM/YYYY" &&
      (m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  }

  if (format === "YYYY/MM/DD" &&
      (m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) {
    return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  }

  return null;
}

function findHeader(rows, required = []) {
  const req = required.map(x => clean(x).toLowerCase());
  return rows.findIndex(row => {
    const headers = row.map(x => clean(x).toLowerCase());
    return req.every(x => headers.includes(x));
  });
}

function normalize(rows, profile, headerIndex = null) {
  const hi = headerIndex ?? findHeader(rows, profile.match?.requiredHeaders || []);
  if (hi < 0) throw new Error("Profile headers not found.");

  const headers = rows[hi].map(clean);
  const lower = headers.map(x => x.toLowerCase());
  const col = name => lower.indexOf(clean(name).toLowerCase());
  const m = profile.mapping || {};

  const dateIndex = col(m.date);
  const descIndex = col(m.description);
  const amountIndex = m.amount ? col(m.amount) : -1;
  const debitIndex = m.debit ? col(m.debit) : -1;
  const creditIndex = m.credit ? col(m.credit) : -1;
  const importedIdIndex = m.importedId ? col(m.importedId) : -1;

  if (dateIndex < 0 || descIndex < 0) {
    throw new Error("Date or description column is missing.");
  }

  const output = [];
  const warnings = [];

  rows.slice(hi + 1).forEach((row, index) => {
    if (!row.some(x => clean(x))) return;

    const date = parseDate(row[dateIndex], profile.dateFormat);
    const description = clean(row[descIndex]).replaceAll("&amp;", "&");
    let amount = null;

    if (profile.amountMode === "single") {
      amount = parseMoney(row[amountIndex]);

      if (amount !== null && profile.singleAmountSign === "invert") amount *= -1;
      if (amount !== null && profile.singleAmountSign === "expenses-negative") {
        amount = -Math.abs(amount);
      }
      if (amount !== null && profile.singleAmountSign === "expenses-positive") {
        amount = Math.abs(amount);
      }
    } else {
      const debit = debitIndex >= 0 ? parseMoney(row[debitIndex]) : null;
      const credit = creditIndex >= 0 ? parseMoney(row[creditIndex]) : null;

      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amount = Math.abs(credit);
    }

    if (!date || amount === null || !description) {
      warnings.push(
        `Source row ${hi + index + 2} skipped: invalid date, amount, or description.`
      );
      return;
    }

    const transaction = { date, amount, description };

    if (importedIdIndex >= 0 && clean(row[importedIdIndex])) {
      transaction.importedId = clean(row[importedIdIndex]);
    }

    output.push(transaction);
  });

  return { rows: output, warnings, headers, headerIndex: hi };
}

async function listProfiles() {
  await ensureData();
  const output = [];

  for (const file of (await fs.readdir(PROFILE_DIR)).filter(x => x.endsWith(".json"))) {
    try {
      output.push(JSON.parse(await fs.readFile(path.join(PROFILE_DIR, file), "utf8")));
    } catch {}
  }

  return output.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- Actual Budget integration ---------------- */

let actualQueue = Promise.resolve();

function serializedActual(fn) {
  const run = actualQueue.then(fn, fn);
  actualQueue = run.catch(() => {});
  return run;
}

async function initActualServer(config) {
  if (!config.serverURL || !config.password) {
    throw new Error("Actual server URL and password are required.");
  }

  await actual.init({
    dataDir: ACTUAL_CACHE,
    serverURL: config.serverURL,
    password: config.password
  });
}

function normalizedVersion(value) {
  const match = String(value || "").match(/\d+\.\d+\.\d+/);
  return match ? match[0] : String(value || "").replace(/^v/i, "");
}

function readServerVersion(result) {
  if (typeof result === "string") return result;
  if (result?.version) return String(result.version);
  if (result?.error === "no-server") {
    throw new Error("Actual API is not connected to a server.");
  }
  if (result?.error === "network-failure") {
    throw new Error("Actual Server version could not be detected because the server did not respond.");
  }
  throw new Error("Actual Server returned an unreadable version response.");
}

function compatibilityDetails(serverVersion = null, detectionError = null) {
  const detectedServerVersion = serverVersion
    ? normalizedVersion(serverVersion)
    : null;
  const versionsMatch = detectedServerVersion
    ? normalizedVersion(ACTUAL_API_VERSION) === detectedServerVersion
    : null;

  return {
    importerVersion: IMPORTER_VERSION,
    actualApiVersion: ACTUAL_API_VERSION,
    serverVersion: detectedServerVersion,
    versionsMatch,
    detectionError,
    warning: versionsMatch === false
      ? `Bundled Actual API ${ACTUAL_API_VERSION} does not match Actual Server ${detectedServerVersion}. Version mismatches can cause migration errors or \"No budget file is open\".`
      : null
  };
}

async function detectCompatibility() {
  const settings = await readSettings();
  const config = settings.actual || {};

  if (!config.serverURL || !config.password) {
    return compatibilityDetails(
      null,
      "Save the Actual Server URL and password to detect the server version."
    );
  }

  try {
    const serverVersion = await withActualServer(async api =>
      readServerVersion(await api.getServerVersion())
    );
    return compatibilityDetails(serverVersion);
  } catch (error) {
    return compatibilityDetails(null, friendlyActualError(error));
  }
}

async function withActualServer(fn) {
  return serializedActual(async () => {
    touchActualCache();
    const settings = await readSettings();
    const config = settings.actual || {};

    await initActualServer(config);

    try {
      const result = await fn(actual, config, settings);
      touchActualCache();
      return result;
    } finally {
      try { await actual.shutdown(); } catch {}
    }
  });
}

async function downloadSelectedBudget(config) {
  if (!config.syncId) {
    throw new Error("No Actual budget has been selected.");
  }

  // Correct @actual-app/api call shape:
  // Sync ID is positional, not an object.
  if (config.encryptionPassword) {
    await actual.downloadBudget(config.syncId, {
      password: config.encryptionPassword
    });
  } else {
    await actual.downloadBudget(config.syncId);
  }
}

async function withActualBudget(fn) {
  touchActualCache();
  return serializedActual(async () => {
    const settings = await readSettings();
    const config = settings.actual || {};

    await initActualServer(config);

    try {
      await downloadSelectedBudget(config);
      return await fn(actual, config, settings);
    } finally {
      try { await actual.shutdown(); } catch {}
    }
  });
}

function applyActualImportSign(amount, profile) {
  let value = Number(amount);
  const mode = profile?.actualImportSign || "preserve";

  if (mode === "invert") value *= -1;
  if (mode === "expenses-negative") value = -Math.abs(value);
  if (mode === "expenses-positive") value = Math.abs(value);

  return value;
}

function describeActualSignTransform(rows, profile) {
  const mode = profile?.actualImportSign || "preserve";
  const sourceAmounts = rows
    .map(row => Number(row.amount))
    .filter(Number.isFinite);
  const hasPositive = sourceAmounts.some(amount => amount > 0);
  const hasNegative = sourceAmounts.some(amount => amount < 0);
  const changedCount = sourceAmounts.filter(amount =>
    applyActualImportSign(amount, profile) !== amount
  ).length;

  let warning = null;
  if (hasPositive && hasNegative && mode === "expenses-negative") {
    warning = "This statement contains both positive and negative amounts, but Force every amount negative will send all of them to Actual as payments. Use Invert amount when positive purchases and negative payments/refunds need to swap directions.";
  }
  if (hasPositive && hasNegative && mode === "expenses-positive") {
    warning = "This statement contains both positive and negative amounts, but Force every amount positive will send all of them to Actual as deposits. Use Preserve or Invert amount when both transaction directions must remain distinct.";
  }

  return {
    mode,
    changedCount,
    hasMixedSourceSigns: hasPositive && hasNegative,
    warning
  };
}

function toActualTransactions(rows, profile) {
  return rows.map(row => {
    const transformedAmount = applyActualImportSign(row.amount, profile);

    const transaction = {
      date: row.date,
      amount: actual.utils.amountToInteger(transformedAmount),
      payee_name: row.description
    };

    if (row.importedId) {
      transaction.imported_id = row.importedId;
    }

    return transaction;
  });
}


/* ---------------- Duplicate safety ---------------- */

function normalizePayee(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(a, b) {
  const aa = new Set(normalizePayee(a).split(" ").filter(Boolean));
  const bb = new Set(normalizePayee(b).split(" ").filter(Boolean));

  if (!aa.size || !bb.size) return 0;

  let intersection = 0;
  for (const token of aa) {
    if (bb.has(token)) intersection++;
  }

  const union = new Set([...aa, ...bb]).size;
  return union ? intersection / union : 0;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(a, b) {
  const aa = new Date(`${a}T12:00:00Z`);
  const bb = new Date(`${b}T12:00:00Z`);
  return Math.abs(Math.round((aa - bb) / 86400000));
}

function getExistingPayeeName(transaction, payeeMap) {
  if (transaction.imported_payee) return transaction.imported_payee;

  const payeeId =
    transaction.payee_id ||
    transaction.payee ||
    transaction.payeeId ||
    "";

  return payeeMap.get(payeeId) || "";
}

function summarizeExistingTransaction(transaction, payeeMap) {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    importedId: transaction.imported_id || "",
    payee: getExistingPayeeName(transaction, payeeMap)
  };
}

async function analyzeDuplicates(api, accountId, rows, profile) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      counts: {
        definiteDuplicate: 0,
        likelyDuplicate: 0,
        possibleDuplicate: 0,
        new: 0
      },
      rows: [],
      newRows: []
    };
  }

  const dates = rows
    .map(row => row.date)
    .filter(Boolean)
    .sort();

  const start = addDays(dates[0], -7);
  const end = addDays(dates[dates.length - 1], 7);

  const [existingTransactions, payees] = await Promise.all([
    api.getTransactions(accountId, start, end),
    api.getPayees()
  ]);

  const payeeMap = new Map(
    (payees || []).map(payee => [payee.id, payee.name || ""])
  );

  // Avoid counting split-parent and split-child representations twice.
  const existing = (existingTransactions || [])
    .filter(tx => tx && tx.is_parent !== true)
    .map(tx => summarizeExistingTransaction(tx, payeeMap));

  const byImportedId = new Map();
  for (const tx of existing) {
    if (tx.importedId) {
      if (!byImportedId.has(tx.importedId)) {
        byImportedId.set(tx.importedId, []);
      }
      byImportedId.get(tx.importedId).push(tx);
    }
  }

  // Heuristic matches consume an existing transaction so one existing row
  // cannot make several identical incoming rows all look like duplicates.
  const consumedExistingIds = new Set();
  const analysisRows = [];

  for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex++) {
    const row = rows[sourceIndex];
    const transformedAmount = applyActualImportSign(row.amount, profile);
    const incomingAmount = actual.utils.amountToInteger(transformedAmount);
    const incomingPayee = normalizePayee(row.description);

    let classification = "new";
    let reason = "No existing transaction matched.";
    let matched = null;
    let confidence = "new";

    // Strongest duplicate guarantee: bank-provided imported ID.
    if (row.importedId && byImportedId.has(row.importedId)) {
      matched = byImportedId.get(row.importedId)[0];
      classification = "definiteDuplicate";
      confidence = "definite";
      reason = "Same imported ID already exists in Actual.";
    }

    if (!matched) {
      const exactCandidates = existing.filter(tx =>
        !consumedExistingIds.has(tx.id) &&
        tx.amount === incomingAmount &&
        tx.date === row.date &&
        normalizePayee(tx.payee) === incomingPayee &&
        incomingPayee
      );

      if (exactCandidates.length) {
        matched = exactCandidates[0];
        consumedExistingIds.add(matched.id);
        classification = "likelyDuplicate";
        confidence = "high";
        reason = "Same date, amount, and normalized payee already exist.";
      }
    }

    if (!matched) {
      const possibleCandidates = existing
        .filter(tx =>
          !consumedExistingIds.has(tx.id) &&
          tx.amount === incomingAmount &&
          dayDistance(tx.date, row.date) <= 3
        )
        .map(tx => ({
          tx,
          similarity: tokenSimilarity(tx.payee, row.description),
          days: dayDistance(tx.date, row.date)
        }))
        .filter(candidate =>
          candidate.similarity >= 0.60 ||
          (
            normalizePayee(candidate.tx.payee) &&
            (
              normalizePayee(candidate.tx.payee).includes(incomingPayee) ||
              incomingPayee.includes(normalizePayee(candidate.tx.payee))
            )
          )
        )
        .sort((a, b) =>
          b.similarity - a.similarity ||
          a.days - b.days
        );

      if (possibleCandidates.length) {
        const best = possibleCandidates[0];
        matched = best.tx;
        consumedExistingIds.add(matched.id);
        classification = "possibleDuplicate";
        confidence = "medium";
        reason =
          `Same amount with a similar payee within ${best.days} day(s).`;
      }
    }

    analysisRows.push({
      sourceIndex,
      classification,
      confidence,
      reason,
      incoming: {
        date: row.date,
        amount: actual.utils.integerToAmount
          ? actual.utils.integerToAmount(incomingAmount)
          : incomingAmount / 100,
        sourceAmount: Number(row.amount),
        description: row.description,
        importedId: row.importedId || ""
      },
      existing: matched
        ? {
            id: matched.id,
            date: matched.date,
            amount: actual.utils.integerToAmount
              ? actual.utils.integerToAmount(matched.amount)
              : matched.amount / 100,
            payee: matched.payee,
            importedId: matched.importedId || ""
          }
        : null
    });
  }

  const counts = {
    definiteDuplicate: analysisRows.filter(x => x.classification === "definiteDuplicate").length,
    likelyDuplicate: analysisRows.filter(x => x.classification === "likelyDuplicate").length,
    possibleDuplicate: analysisRows.filter(x => x.classification === "possibleDuplicate").length,
    new: analysisRows.filter(x => x.classification === "new").length
  };

  const newIndexes = new Set(
    analysisRows
      .filter(x => x.classification === "new")
      .map(x => x.sourceIndex)
  );

  return {
    counts,
    rows: analysisRows,
    newRows: rows.filter((_row, index) => newIndexes.has(index)),
    dateRange: { start, end },
    existingTransactionCount: existing.length
  };
}


/* ---------------- API routes ---------------- */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: IMPORTER_VERSION });
});

/* Profiles */

app.get("/api/profiles", async (_req, res, next) => {
  try {
    res.json(await listProfiles());
  } catch (e) {
    next(e);
  }
});

app.post("/api/profiles", async (req, res, next) => {
  try {
    const profile = req.body;

    if (!profile.name || !profile.mapping?.date || !profile.mapping?.description) {
      return res.status(400).json({
        error: "Name, date and description mappings are required."
      });
    }

    profile.id = safeId(profile.id || profile.name);
    profile.version = 1;
    profile.updatedAt = new Date().toISOString();

    // Never store local Actual account associations inside portable profiles.
    delete profile.actualAccountId;

    await ensureData();
    await fs.writeFile(
      path.join(PROFILE_DIR, `${profile.id}.json`),
      JSON.stringify(profile, null, 2)
    );

    res.json(profile);
  } catch (e) {
    next(e);
  }
});

app.delete("/api/profiles/:id", async (req, res, next) => {
  try {
    const id = safeId(req.params.id);

    await fs.unlink(path.join(PROFILE_DIR, `${id}.json`));

    const settings = await readSettings();
    if (settings.actual?.accountMappings) {
      delete settings.actual.accountMappings[id];
      await writeSettings(settings);
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.get("/api/profiles/:id/export", async (req, res, next) => {
  try {
    const id = safeId(req.params.id);
    const content = await fs.readFile(path.join(PROFILE_DIR, `${id}.json`));

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${id}.json"`
    );
    res.send(content);
  } catch (e) {
    next(e);
  }
});

app.post("/api/profiles/import", upload.single("profile"), async (req, res, next) => {
  try {
    const profile = JSON.parse(req.file.buffer.toString("utf8"));

    profile.id = safeId(profile.id || profile.name);
    delete profile.actualAccountId;

    await ensureData();
    await fs.writeFile(
      path.join(PROFILE_DIR, `${profile.id}.json`),
      JSON.stringify(profile, null, 2)
    );

    res.json(profile);
  } catch (e) {
    next(e);
  }
});

/* CSV inspect / conversion */

app.post("/api/inspect", upload.single("file"), async (req, res, next) => {
  try {
    const rows = parseDelimited(decode(req.file.buffer));
    const profiles = await listProfiles();

    let detected = null;

    for (const profile of profiles) {
      const headerIndex = findHeader(
        rows,
        profile.match?.requiredHeaders || []
      );

      if (headerIndex >= 0) {
        detected = { profile, headerIndex };
        break;
      }
    }

    let headerIndex = detected?.headerIndex ?? 0;

    if (!detected) {
      let best = -1;
      let bestScore = -1;

      rows.slice(0, 15).forEach((row, i) => {
        const score = row.filter(v => clean(v)).length;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });

      headerIndex = Math.max(0, best);
    }

    res.json({
      filename: req.file.originalname,
      detectedProfile: detected?.profile || null,
      headerIndex,
      headers: (rows[headerIndex] || []).map(clean),
      sampleRows: rows
        .slice(headerIndex + 1, headerIndex + 7)
        .map(row => row.map(clean))
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/convert", upload.single("file"), async (req, res, next) => {
  try {
    const profile = JSON.parse(req.body.profile);
    const rows = parseDelimited(
      decode(req.file.buffer),
      profile.delimiter || ","
    );

    res.json(
      normalize(rows, profile, Number(req.body.headerIndex))
    );
  } catch (e) {
    next(e);
  }
});

/* Actual connection settings */

app.get("/api/actual/compatibility", async (_req, res, next) => {
  try {
    res.json(await detectCompatibility());
  } catch (e) {
    next(e);
  }
});

app.get("/api/actual/settings", async (_req, res, next) => {
  try {
    const settings = await readSettings();
    const a = settings.actual || {};

    res.json({
      serverURL: a.serverURL || "",
      syncId: a.syncId || "",
      budgetName: a.budgetName || "",
      hasPassword: !!a.password,
      hasEncryptionPassword: !!a.encryptionPassword,
      accountMappings: a.accountMappings || {}
    });
  } catch (e) {
    next(e);
  }
});

app.put("/api/actual/settings", async (req, res, next) => {
  try {
    const settings = await readSettings();
    const current = settings.actual || {};
    const body = req.body || {};

    settings.actual = {
      serverURL: clean(body.serverURL ?? current.serverURL),
      syncId: clean(body.syncId ?? current.syncId),
      budgetName: clean(body.budgetName ?? current.budgetName),
      password: body.password
        ? String(body.password)
        : current.password || "",
      encryptionPassword: body.encryptionPassword
        ? String(body.encryptionPassword)
        : current.encryptionPassword || "",
      accountMappings: current.accountMappings || {}
    };

    if (body.clearPassword === true) {
      settings.actual.password = "";
    }

    if (body.clearEncryptionPassword === true) {
      settings.actual.encryptionPassword = "";
    }

    await writeSettings(settings);

    res.json({
      ok: true,
      serverURL: settings.actual.serverURL,
      syncId: settings.actual.syncId,
      budgetName: settings.actual.budgetName,
      hasPassword: !!settings.actual.password,
      hasEncryptionPassword: !!settings.actual.encryptionPassword
    });
  } catch (e) {
    next(e);
  }
});

/* Discover budgets before downloading one */

app.get("/api/actual/budgets", async (_req, res, next) => {
  try {
    const budgets = await withActualServer(api => api.getBudgets());

    // Actual may return both a cached/local copy and a remote/server copy
    // of the same budget. Deduplicate by Sync ID (groupId), preferring the
    // remote entry when both exist.
    const bySyncId = new Map();

    for (const budget of budgets) {
      const syncId = budget.groupId || "";

      // Budgets without a groupId cannot be safely selected for server sync.
      if (!syncId) continue;

      const normalized = {
        name: budget.name,
        syncId,
        cloudFileId: budget.cloudFileId || "",
        state: budget.state || "",
        encrypted: !!budget.encryptKeyId
      };

      const existing = bySyncId.get(syncId);

      if (!existing) {
        bySyncId.set(syncId, normalized);
        continue;
      }

      const existingIsRemote = existing.state === "remote";
      const currentIsRemote = normalized.state === "remote";

      if (currentIsRemote && !existingIsRemote) {
        bySyncId.set(syncId, normalized);
      }
    }

    res.json(
      [...bySyncId.values()].sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""))
      )
    );
  } catch (e) {
    next(e);
  }
});

app.post("/api/actual/select-budget", async (req, res, next) => {
  try {
    const syncId = clean(req.body?.syncId);
    const budgetName = clean(req.body?.budgetName);

    if (!syncId) {
      return res.status(400).json({
        error: "Budget Sync ID is required."
      });
    }

    const settings = await readSettings();
    settings.actual = settings.actual || {};
    settings.actual.syncId = syncId;
    settings.actual.budgetName = budgetName;
    settings.actual.accountMappings =
      settings.actual.accountMappings || {};

    await writeSettings(settings);

    res.json({ ok: true, syncId, budgetName });
  } catch (e) {
    next(e);
  }
});

/* Test selected budget and discover accounts */

app.post("/api/actual/test", async (_req, res, next) => {
  try {
    const result = await withActualBudget(async api => {
      const serverVersion = readServerVersion(await api.getServerVersion());
      return {
        accounts: (await api.getAccounts()).length,
        compatibility: compatibilityDetails(serverVersion)
      };
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

app.get("/api/actual/accounts", async (_req, res, next) => {
  try {
    const accounts = await withActualBudget(api => api.getAccounts());

    res.json(
      accounts.map(account => ({
        id: account.id,
        name: account.name,
        closed: !!account.closed,
        offbudget: !!account.offbudget
      }))
    );
  } catch (e) {
    next(e);
  }
});

app.put("/api/actual/mappings/:profileId", async (req, res, next) => {
  try {
    const settings = await readSettings();

    settings.actual = settings.actual || {};
    settings.actual.accountMappings =
      settings.actual.accountMappings || {};

    const profileId = safeId(req.params.profileId);
    const accountId = clean(req.body.accountId);

    if (accountId) {
      settings.actual.accountMappings[profileId] = accountId;
    } else {
      delete settings.actual.accountMappings[profileId];
    }

    await writeSettings(settings);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* Safe dry run + confirmed import */

async function reviewActualCandidates(api, accountId, rows, profile, analysis) {
  for (const row of analysis.rows) {
    if (row.classification !== "new") continue;
    const transaction = toActualTransactions([rows[row.sourceIndex]], profile)[0];
    Object.assign(row, await probeTransaction(api, accountId, transaction));
    if (row.classification === "actualMatched") {
      row.matchCandidates = await getMatchCandidates(api, accountId, transaction);
      row.canImportSeparately = canImportSeparately(transaction, row.matchCandidates);
      if (!row.canImportSeparately) row.reason += " Separate import is unavailable for bank import IDs, same-day amount matches, or missing candidates.";
    }
  }
  for (const classification of ["new", "previouslyDeleted", "actualSkipped", "actualMatched", "actualError"]) {
    analysis.counts[classification] = analysis.rows.filter(row => row.classification === classification).length;
  }
  analysis.newRows = analysis.rows.filter(row => row.classification === "new")
    .map(row => rows[row.sourceIndex]);
  return analysis;
}

app.post("/api/actual/dry-run", async (req, res, next) => {
  try {
    const { profileId, rows } = req.body || {};

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({
        error: "No transactions supplied."
      });
    }

    const settings = await readSettings();
    const accountId =
      settings.actual?.accountMappings?.[safeId(profileId)];

    if (!accountId) {
      return res.status(400).json({
        error: "This profile is not mapped to an Actual account."
      });
    }

    const profilePath =
      path.join(PROFILE_DIR, `${safeId(profileId)}.json`);

    const profile =
      JSON.parse(await fs.readFile(profilePath, "utf8"));

    const result = await withActualBudget(async api => {
      const duplicateAnalysis =
        await analyzeDuplicates(api, accountId, rows, profile);

      await reviewActualCandidates(api, accountId, rows, profile, duplicateAnalysis);
      const actualDryRun = {
        added: duplicateAnalysis.counts.new,
        updated: 0,
        errors: duplicateAnalysis.counts.actualError
      };

      return {
        duplicateAnalysis,
        actualDryRun
      };
    });

    res.json({
      ok: true,
      safety: {
        counts: result.duplicateAnalysis.counts,
        rows: result.duplicateAnalysis.rows,
        existingTransactionCount:
          result.duplicateAnalysis.existingTransactionCount,
        dateRange: result.duplicateAnalysis.dateRange,
        eligibleForSafeImport:
          result.duplicateAnalysis.newRows.length,
        signTransform: describeActualSignTransform(rows, profile)
      },
      actual: result.actualDryRun
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/actual/import", async (req, res, next) => {
  try {
    const { profileId, rows, confirm, restoreIndexes = [], separateIndexes = [], confirmSeparate = false } = req.body || {};

    if (confirm !== true) {
      return res.status(400).json({
        error: "Import confirmation is required."
      });
    }

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({
        error: "No transactions supplied."
      });
    }

    if (!Array.isArray(restoreIndexes) || restoreIndexes.some(index =>
      !Number.isInteger(index) || index < 0 || index >= rows.length)) {
      return res.status(400).json({ error: "Invalid deleted-transaction selection. Run the preview again." });
    }
    const selectedRestores = new Set(restoreIndexes);
    if (!Array.isArray(separateIndexes) || separateIndexes.some(index =>
      !Number.isInteger(index) || index < 0 || index >= rows.length || selectedRestores.has(index)) ||
      (separateIndexes.length > 0 && confirmSeparate !== true)) {
      return res.status(400).json({ error: "Invalid or unconfirmed separate-transaction selection. Run the preview again." });
    }
    const selectedSeparate = new Set(separateIndexes);

    const settings = await readSettings();
    const accountId =
      settings.actual?.accountMappings?.[safeId(profileId)];

    if (!accountId) {
      return res.status(400).json({
        error: "This profile is not mapped to an Actual account."
      });
    }

    // Re-run duplicate analysis at import time. Never trust a stale
    // browser-side preflight to decide what is safe to send.
    const profilePath =
      path.join(PROFILE_DIR, `${safeId(profileId)}.json`);

    const profile =
      JSON.parse(await fs.readFile(profilePath, "utf8"));

    const result = await withActualBudget(async api => {
      const duplicateAnalysis =
        await analyzeDuplicates(api, accountId, rows, profile);

      await reviewActualCandidates(api, accountId, rows, profile, duplicateAnalysis);
      const importResult = { added: [], updated: [], errors: [] };
      let skippedActual = 0;
      let addedSeparately = 0;
      for (const row of duplicateAnalysis.rows) {
        const selected = selectedRestores.has(row.sourceIndex);
        const separate = selectedSeparate.has(row.sourceIndex) && row.classification === "actualMatched" && row.canImportSeparately;
        if (row.classification !== "new" && !(row.classification === "previouslyDeleted" && selected) && !separate) {
          if (["previouslyDeleted", "actualSkipped", "actualMatched", "actualError"].includes(row.classification)) skippedActual++;
          continue;
        }
        const transaction = toActualTransactions([rows[row.sourceIndex]], profile)[0];
        try {
          const outcome = separate
            ? await importSeparateCandidate(api, accountId, transaction)
            : await importCandidate(api, accountId, transaction, row.classification, selected);
          if (separate) addedSeparately += outcome.added?.length || 0;
          for (const field of ["added", "updated", "errors"]) {
            importResult[field].push(...(outcome[field] || []));
          }
          if (outcome.skipped || (!outcome.added?.length && !outcome.updated?.length && !outcome.errors?.length)) skippedActual++;
        } catch (error) {
          importResult.errors.push({ message: error.message });
          // Earlier rows may have succeeded; return their counts rather than
          // hiding them behind a generic failed-request response.
        }
      }

      return {
        importResult,
        skippedActual,
        addedSeparately,
        duplicateAnalysis
      };
    });

    res.json({
      ok: true,
      summary: {
        added: result.importResult.added?.length || 0,
        updated: result.importResult.updated?.length || 0,
        errors: result.importResult.errors?.length || 0,
        skippedActual: result.skippedActual,
        addedSeparately: result.addedSeparately,
        skippedDefinite:
          result.duplicateAnalysis.counts.definiteDuplicate,
        skippedLikely:
          result.duplicateAnalysis.counts.likelyDuplicate,
        skippedPossible:
          result.duplicateAnalysis.counts.possibleDuplicate
      }
    });
  } catch (e) {
    next(e);
  }
});

function friendlyActualError(error) {
  const original = String(error?.message || error || "Internal server error");
  const message = original.toLowerCase();

  if (message.includes("no budget file is open")) {
    return `No budget file is open. Confirm the selected budget, then make sure Actual API ${ACTUAL_API_VERSION} matches the Actual Server version. A version mismatch can prevent the budget from opening or completing migrations.`;
  }
  if (message.includes("migration")) {
    return `${original} Check that Actual API ${ACTUAL_API_VERSION} matches the Actual Server version; mismatches can cause migration failures.`;
  }
  if (message.includes("certificate") || message.includes("self signed")) {
    return `${original} If the server uses a private certificate, configure ACTUAL_CA_CERT_PATH and NODE_EXTRA_CA_CERTS as described in the README.`;
  }
  if (message.includes("fetch failed") || message.includes("econnrefused") || message.includes("network")) {
    return `${original} Verify that the Actual Server URL is reachable from the importer container.`;
  }

  return original;
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({
    error: friendlyActualError(err),
    code: err.code || undefined
  });
});

await ensureData();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Actual Budget CSV Importer v${IMPORTER_VERSION} on ${PORT}`);
});
