(function () {
  document.getElementById("yr").textContent = new Date().getFullYear();

  // only one video plays at a time
  var vids = document.querySelectorAll("video");
  vids.forEach(function (v) {
    v.addEventListener("play", function () {
      vids.forEach(function (o) { if (o !== v) o.pause(); });
    });
  });

  function wire(id, url, build, okText) {
    var form = document.getElementById(id);
    if (!form) return;
    var msg = form.querySelector(".msg");
    var btn = form.querySelector("button[type=submit]");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "msg"; msg.textContent = "";
      var bad = Array.prototype.find.call(form.querySelectorAll("[required]"), function (el) {
        return !el.value.trim() || (el.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.value.trim()));
      });
      if (bad) {
        msg.className = "msg err";
        msg.textContent = bad.type === "email" ? "Please enter a valid email address." : "Please fill in the highlighted field.";
        bad.focus(); return;
      }
      btn.disabled = true;
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(build(form)) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j && res.j.error || "Something went wrong.");
          form.reset();
          msg.className = "msg ok"; msg.textContent = okText;
        })
        .catch(function (err) {
          msg.className = "msg err"; msg.textContent = err.message || "Something went wrong. Please try again.";
        })
        .finally(function () { btn.disabled = false; });
    });
  }

  function cats(form) {
    return Array.prototype.map.call(form.querySelectorAll("input[name=cats]:checked"), function (c) { return c.value; });
  }

  wire("alerts-form", "/api/alerts", function (f) {
    return { email: f.elements["email"].value.trim(), categories: cats(f), website: f.elements["website"].value };
  }, "You're on the list. Your first SALES ALERT arrives when we launch.");

  wire("early-form", "/api/early-access", function (f) {
    return {
      business: f.elements["business"].value.trim(), site: f.elements["site"].value.trim(),
      kind: (f.querySelector("input[name=kind]:checked") || {}).value || "",
      categories: cats(f), other: f.elements["other"].value.trim(),
      name: f.elements["name"].value.trim(), email: f.elements["email"].value.trim(), website: f.elements["website"].value
    };
  }, "Thanks. We'll be in touch about founding-seller access.");
})();
