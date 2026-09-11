// Puts "Trial history" in the admin sidebar WITHOUT editing app.js.
//
// app.js is 863KB of the live front end and the whole port depends on it
// staying byte-identical to the tree running on the VPS (§7.4) — one edit here
// and every future update from the real system has to be merged by hand. So
// the link is injected instead: renderNav() is wrapped, and the item is added
// after each render.
//
// It has to re-run on every render, not once at boot: renderNav() is called
// again on login, on language change, after Customise Menu, and whenever
// syncMyPerms notices the permission map moved. Any of those would otherwise
// wipe the link out of the sidebar.
//
// The page it points at is a normal document, not an app view, because
// prospects must never see each other and app.js must not learn about it.
// Its gate is in the database anyway: trial_sessions_list() and
// trial_session_activity() refuse anyone who is not an admin, so this link
// is a convenience, never the security boundary.
(function () {
  if (typeof TRANSLATIONS !== "undefined") {
    var add = {
      en: { nav_trial_history: "Trial history" },
      ar: { nav_trial_history: "سجل التجارب" }
    };
    Object.keys(add).forEach(function (lang) {
      if (!TRANSLATIONS[lang]) return;
      Object.keys(add[lang]).forEach(function (k) {
        if (!(k in TRANSLATIONS[lang])) TRANSLATIONS[lang][k] = add[lang][k];
      });
    });
  }

  function label() {
    return (typeof t === "function") ? t("nav_trial_history") : "Trial history";
  }

  function inject() {
    if (typeof role !== "function" || role() !== "admin") return;
    var nav = document.getElementById("nav");
    if (!nav || nav.querySelector("#nav-trial-history")) return;
    var a = document.createElement("a");
    a.className = "nav-item";
    a.id = "nav-trial-history";
    a.href = "/trial-history.html";
    a.innerHTML = "<span>\u{1F50E} " + label() + "</span>";
    // before the gear, so Customise Menu stays the last thing in the list
    var gear = nav.querySelector("#nav-customise");
    if (gear) nav.insertBefore(a, gear); else nav.appendChild(a);
  }

  if (typeof renderNav === "function") {
    var orig = renderNav;
    window.renderNav = function () {
      var r = orig.apply(this, arguments);
      try { inject(); } catch (e) { /* never break the sidebar over a link */ }
      return r;
    };
  }
  if (document.getElementById("nav")) { try { inject(); } catch (e) {} }
})();
