// Labels for things that exist only in the demo, added WITHOUT editing
// i18n.js or app.js — both of which stay byte-identical to the live tree
// (§7.4). t() falls back to the raw key when a string is missing, so a role
// with no entry would render as "role_trial" in the sidebar and on the staff
// list. TRANSLATIONS is a const binding to a mutable object, so extending it
// here — after i18n.js, before app.js — is enough.
(function () {
  if (typeof TRANSLATIONS === "undefined") return;
  var add = {
    en: {
      role_trial: "Trial",
      role_intro_trial: "Evaluation account. Explore freely — nothing is saved."
    },
    ar: {
      role_trial: "تجريبي",
      role_intro_trial: "حساب للتجربة. تصفح بحرية — لا يتم حفظ أي تغيير."
    }
  };
  Object.keys(add).forEach(function (lang) {
    if (!TRANSLATIONS[lang]) return;
    Object.keys(add[lang]).forEach(function (k) {
      if (!(k in TRANSLATIONS[lang])) TRANSLATIONS[lang][k] = add[lang][k];
    });
  });
})();
