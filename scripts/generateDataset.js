/**
 * generateDataset.js
 * -------------------
 * Produces a CSV file `data/queries.csv` with at least 100,000 UNIQUE
 * search queries and a realistic, Zipf-like popularity count for each.
 *
 * WHY GENERATE INSTEAD OF DOWNLOAD?
 *   The assignment says "use any dataset" and "if counts are missing,
 *   derive them via aggregation". A generated dataset is:
 *     - reproducible (a fixed seed => identical file every run),
 *     - offline (no network needed for `npm start`), and
 *     - shaped on purpose (we control the popularity distribution so the
 *       trending/top-10 features have interesting data to show).
 *
 * WHY A ZIPF-LIKE DISTRIBUTION?
 *   Real search traffic is heavily skewed: a few queries ("iphone") are
 *   searched millions of times while the long tail is searched rarely.
 *   Zipf's law says the n-th most popular item gets ~1/n of the traffic
 *   of the most popular one. Mimicking this makes caching and trending
 *   behave like they would in production.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, '..', 'data', 'queries.csv');
const TARGET = 120_000; // generate a comfortable margin above the 100k minimum

/**
 * mulberry32 — a tiny, fast, *deterministic* pseudo-random generator.
 * We seed it with a constant so the dataset is identical on every machine.
 * (Math.random() is not seedable, so we can't get reproducibility from it.)
 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(12345);

// --- Vocabulary used to build realistic queries -------------------------
const brands = [
  'apple', 'samsung', 'sony', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'lg',
  'xiaomi', 'oneplus', 'google', 'microsoft', 'bose', 'jbl', 'nike', 'adidas',
  'puma', 'canon', 'nikon', 'gopro', 'intel', 'amd', 'nvidia', 'logitech',
  'razer', 'corsair', 'philips', 'panasonic', 'realme', 'oppo', 'vivo', 'nokia',
  'motorola', 'huawei', 'amazon', 'tcl', 'toshiba', 'sandisk', 'kingston',
];
const products = [
  'phone', 'laptop', 'tablet', 'charger', 'case', 'cover', 'headphones',
  'earbuds', 'watch', 'monitor', 'keyboard', 'mouse', 'tv', 'camera', 'speaker',
  'router', 'ssd', 'hard drive', 'power bank', 'cable', 'adapter', 'stand',
  'webcam', 'microphone', 'printer', 'scanner', 'projector', 'drone', 'console',
  'controller', 'graphics card', 'processor', 'ram', 'motherboard', 'cooler',
];
const modifiers = [
  'pro', 'max', 'ultra', 'mini', 'plus', 'lite', 'air', 'price', 'review',
  'deals', 'offers', 'discount', 'best', 'cheap', 'buy online', 'near me',
  'specifications', 'features', 'comparison', 'unboxing', '2023', '2024', '2025',
  'black', 'white', 'silver', 'gold', 'blue', 'red', '64gb', '128gb', '256gb',
  '512gb', '1tb', 'wireless', 'bluetooth', 'gaming', '4k', 'hd',
];
const langs = [
  'java', 'python', 'javascript', 'typescript', 'c++', 'c#', 'go', 'rust',
  'ruby', 'php', 'kotlin', 'swift', 'scala', 'r', 'sql', 'html', 'css', 'react',
  'angular', 'vue', 'node', 'spring', 'django', 'flask', 'express',
];
const topics = [
  'tutorial', 'course', 'interview questions', 'cheat sheet', 'examples',
  'documentation', 'roadmap', 'projects', 'for beginners', 'advanced',
  'crash course', 'certification', 'vs python', 'jobs', 'salary', 'tips',
  'best practices', 'design patterns', 'data structures', 'algorithms',
];
const foods = [
  'pizza', 'burger', 'sushi', 'pasta', 'biryani', 'tacos', 'noodles', 'salad',
  'coffee', 'ice cream', 'cake', 'sandwich', 'chicken', 'paneer', 'dosa',
];
const foodMods = [
  'near me', 'recipe', 'delivery', 'restaurant', 'home delivery', 'price',
  'best', 'order online', 'vegan', 'spicy', 'calories', 'offers',
];

const queries = new Map(); // query -> raw weight (popularity rank seed)

/** Add a query if new; the insertion order roughly tracks popularity. */
function add(q) {
  q = q.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q && !queries.has(q)) queries.set(q, queries.size + 1);
}

// 0) Curated real-world flagship queries — inserted FIRST so they earn the
//    highest popularity ranks (and therefore the biggest counts). This makes
//    the demo match what people actually type ("iphone 15 pro", "airpods").
const flagships = [
  'iphone', 'iphone 15', 'iphone 15 pro', 'iphone 15 pro max', 'iphone 14',
  'iphone 13', 'iphone charger', 'iphone case', 'iphone 16', 'ipad', 'ipad pro',
  'ipad air', 'macbook', 'macbook pro', 'macbook air', 'airpods', 'airpods pro',
  'airpods max', 'apple watch', 'samsung galaxy', 'galaxy s24', 'galaxy s24 ultra',
  'galaxy s23', 'galaxy buds', 'galaxy watch', 'pixel 8', 'pixel 8 pro', 'pixel buds',
  'playstation 5', 'ps5', 'xbox series x', 'nintendo switch', 'kindle',
  'java tutorial', 'python tutorial', 'javascript tutorial', 'react tutorial',
];
flagships.forEach(add);

// 1) Single high-value head terms (most popular).
[...brands, ...langs, ...products, ...foods].forEach(add);

// 2) brand + product (very common search shape: "apple laptop").
for (const b of brands) for (const p of products) add(`${b} ${p}`);

// 3) brand + product + modifier ("apple laptop pro").
for (const b of brands) for (const p of products) for (const m of modifiers) add(`${b} ${p} ${m}`);

// 4) programming: lang + topic ("java tutorial").
for (const l of langs) for (const t of topics) add(`${l} ${t}`);

// 5) food: food + modifier ("pizza near me").
for (const f of foods) for (const m of foodMods) add(`${f} ${m}`);

// 6) Top up to TARGET with deterministic extra combinations if needed.
const fillers = [...brands, ...products, ...langs, ...foods];
let guard = 0;
while (queries.size < TARGET && guard < TARGET * 50) {
  guard++;
  const a = fillers[Math.floor(rand() * fillers.length)];
  const b = products[Math.floor(rand() * products.length)];
  const m = modifiers[Math.floor(rand() * modifiers.length)];
  add(`${a} ${b} ${m}`);
}

// --- Assign Zipf-like counts -------------------------------------------
// rank 1 (first inserted) is the most popular. count ≈ BASE / rank^0.85,
// with a little deterministic noise so ties are broken naturally.
const BASE = 2_000_000;
const rows = [];
for (const [q, rank] of queries) {
  const zipf = BASE / Math.pow(rank, 0.85);
  const noise = 0.75 + rand() * 0.5; // 0.75x .. 1.25x
  const count = Math.max(1, Math.round(zipf * noise));
  rows.push(`${q},${count}`);
}

fs.writeFileSync(OUT_FILE, 'query,count\n' + rows.join('\n') + '\n');
console.log(`Wrote ${rows.length.toLocaleString()} queries to ${OUT_FILE}`);
console.log('Sample (most popular):');
console.log('  ' + rows.slice(0, 5).join('\n  '));
