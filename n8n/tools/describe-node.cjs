// Dev helper: prints the parameters of an n8n node type/version, as defined by the installed n8n.
// Run inside the n8n container:
//   docker compose exec -T n8n node - <relative node path> <version> < n8n/tools/describe-node.cjs
// e.g. Form/FormTrigger.node.js 2.6
const path = require("node:path");
const fs = require("node:fs");

function findNodesBase() {
  const root = "/usr/local/lib/node_modules/n8n/node_modules/.pnpm";
  const dir = fs.readdirSync(root).find((d) => d.startsWith("n8n-nodes-base@"));
  return path.join(root, dir, "node_modules", "n8n-nodes-base", "dist", "nodes");
}

const [rel, versionArg] = process.argv.slice(2);
const mod = require(path.join(findNodesBase(), rel));
const Cls = Object.values(mod).find((v) => typeof v === "function");
const inst = new Cls();
let desc = inst.description;
if (inst.nodeVersions) {
  const v = Number(versionArg ?? inst.description.defaultVersion);
  desc = inst.nodeVersions[v]?.description;
  if (!desc) {
    console.log("versions:", Object.keys(inst.nodeVersions).join(", "));
    process.exit(1);
  }
}
const show = (props, indent = "") => {
  for (const p of props ?? []) {
    const opts = p.options && p.type !== "collection" && p.type !== "fixedCollection"
      ? ` options=[${p.options.map((o) => o.value ?? o.name).join("|")}]` : "";
    const disp = p.displayOptions?.show ? ` show=${JSON.stringify(p.displayOptions.show)}` : "";
    const def = p.default !== undefined && typeof p.default !== "object" ? ` default=${JSON.stringify(p.default)}` : "";
    console.log(`${indent}${p.name} [${p.type}]${def}${opts}${disp}`);
    if (p.type === "collection") show(p.options, indent + "    ");
    if (p.type === "fixedCollection") for (const o of p.options ?? []) { console.log(`${indent}  .${o.name}:`); show(o.values, indent + "    "); }
  }
};
console.log(`${desc.name} v${versionArg ?? desc.defaultVersion ?? desc.version}`);
show(desc.properties);
