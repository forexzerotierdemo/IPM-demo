// Run the DEPLOYED nav-extra.js against a minimal DOM, in a real VM context so
// its globals behave the way they do in the browser.
const vm = require("vm");
const fs = require("fs");

function El(tag){
  return {
    tagName: tag, id: "", className: "", href: "", innerHTML: "",
    children: [],
    get textContent(){ return String(this.innerHTML).replace(/<[^>]*>/g, ""); },
    setAttribute(k,v){ this[k]=v; },
    getAttribute(k){ return this[k]; },
    appendChild(c){ this.children.push(c); return c; },
    insertBefore(c, ref){ const i=this.children.indexOf(ref); this.children.splice(i<0?this.children.length:i,0,c); return c; },
    querySelector(sel){ return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel){
      const id = sel.startsWith("#") ? sel.slice(1) : null;
      const out=[];
      (function walk(n){ n.children.forEach(c=>{ if(id && c.id===id) out.push(c); walk(c); }); })(this);
      return out;
    },
  };
}

const nav = El("div"); nav.id = "nav";
const sandbox = {
  TRANSLATIONS: { en:{}, ar:{} },
  document: {
    getElementById: id => (id === "nav" ? nav : null),
    createElement: t => El(t),
  },
};
sandbox.window = sandbox;
let who = "manager";
sandbox.role = () => who;
let lang = "en";
sandbox.t = k => sandbox.TRANSLATIONS[lang][k] || k;
// stand-in for app.js's renderNav: rebuilds the sidebar from scratch each time
sandbox.renderNav = function(){
  nav.children = [];
  const home = El("a"); home.id = "nav-dashboard"; nav.appendChild(home);
  if (who === "admin"){ const g = El("a"); g.id = "nav-customise"; nav.appendChild(g); }
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require("path").join(__dirname,"..","web","js","nav-extra.js"),"utf8"), sandbox);

let pass=0, fail=0;
const ck=(n,ok,d="")=>{ ok?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n+(d?" — "+d:""))); };
const link = () => nav.querySelector("#nav-trial-history");

sandbox.renderNav();
ck("a manager never sees the link", link() === null);

who = "admin"; sandbox.renderNav();
ck("an admin does", !!link());
ck("...pointing at the history page", link() && link().href === "/trial-history.html", link() && link().href);
ck("...labelled in English", link() && /Trial history/.test(link().textContent), link() && link().textContent);
ck("...placed before Customise, which stays last",
   nav.children.map(c=>c.id).join(",") === "nav-dashboard,nav-trial-history,nav-customise",
   nav.children.map(c=>c.id).join(","));

sandbox.renderNav(); sandbox.renderNav();
ck("it survives re-renders (login, language, Customise, perm sync)", !!link());
ck("...without ever duplicating", nav.querySelectorAll("#nav-trial-history").length === 1,
   "copies=" + nav.querySelectorAll("#nav-trial-history").length);

lang = "ar"; nav.children = []; sandbox.renderNav();
ck("Arabic label is used in Arabic", link() && link().textContent.indexOf("سجل") >= 0,
   link() && link().textContent);

ck("labels were added without clobbering i18n.js",
   sandbox.TRANSLATIONS.en.nav_trial_history === "Trial history" &&
   !!sandbox.TRANSLATIONS.ar.nav_trial_history);

// a broken t() must never take the sidebar down with it
sandbox.t = () => { throw new Error("i18n exploded"); };
nav.children = [];
let threw = false;
try { sandbox.renderNav(); } catch(e){ threw = true; }
ck("a failure inside the injector cannot break the sidebar", !threw);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
