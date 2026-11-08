// Admin mode helpers: show the fields matching the chosen visibility,
// "select all" photos, confirmations, and an upload progress bar.
(function () {
  "use strict";

  const form = document.getElementById("gallery-form");
  if (form) {
    const update = function () {
      const checked = form.querySelector('input[name="visibility"]:checked');
      const isPrivate = checked && checked.value === "private";
      form.querySelector(".admin-when-private").hidden = !isPrivate;
      form.querySelector(".admin-when-public").hidden = isPrivate;
      form.querySelector("#f-password").required = isPrivate;
    };
    form.querySelectorAll('input[name="visibility"]').forEach(function (r) {
      r.addEventListener("change", update);
    });
    update();
  }

  const selectAll = document.getElementById("select-all");
  if (selectAll) {
    selectAll.addEventListener("change", function () {
      document.querySelectorAll('#photos-form input[name="photo"]').forEach(function (c) {
        c.checked = selectAll.checked;
      });
    });
  }

  document.querySelectorAll("[data-confirm]").forEach(function (button) {
    button.addEventListener("click", function (e) {
      if (!window.confirm(button.dataset.confirm)) e.preventDefault();
    });
  });

  const upload = document.getElementById("upload-form");
  if (upload) {
    const input = upload.querySelector('input[type="file"]');
    const zone = upload.querySelector(".admin-dropzone");
    const info = upload.querySelector(".admin-upload-info");
    const bar = upload.querySelector(".admin-progress");
    const button = upload.querySelector('button[type="submit"]');

    const describe = function () {
      const files = Array.from(input.files || []);
      const mb = files.reduce(function (s, f) { return s + f.size; }, 0) / 1048576;
      info.textContent = files.length ? files.length + " file(s) selected, " + mb.toFixed(1) + " MB" : "";
    };
    input.addEventListener("change", describe);

    ["dragenter", "dragover"].forEach(function (type) {
      zone.addEventListener(type, function (e) {
        e.preventDefault();
        zone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      zone.addEventListener(type, function () { zone.classList.remove("is-dragover"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        describe();
      }
    });

    const errorList = upload.querySelector(".admin-upload-errors");

    // Turns a failed request into a sentence the photographer can act on.
    function failureReason(xhr) {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
      if (body && body.message) return body.message;
      if (xhr.status === 413) {
        return "refused by the web server as too large (raise client_max_body_size in the reverse proxy for this site)";
      }
      if (xhr.status === 403) return "the page expired - reload it and try again";
      if (xhr.status === 0) return "connection lost";
      if (xhr.status === 200) return "your admin session expired - reload the page and sign in again";
      return "server error " + xhr.status;
    }

    // Sends one file; resolves with { ok, reason }. `onProgress` gets the
    // bytes sent so far for this file.
    function sendOne(file, onProgress) {
      return new Promise(function (resolve) {
        const data = new FormData();
        data.append("photos", file, file.name);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", upload.action);
        xhr.setRequestHeader("Accept", "application/json");
        xhr.upload.addEventListener("progress", function (ev) { onProgress(ev.loaded); });
        xhr.addEventListener("load", function () {
          const isJson = (xhr.getResponseHeader("Content-Type") || "").indexOf("application/json") !== -1;
          const ok = xhr.status === 200 && isJson && JSON.parse(xhr.responseText).ok;
          resolve(ok ? { ok: true } : { ok: false, reason: failureReason(xhr) });
        });
        xhr.addEventListener("error", function () { resolve({ ok: false, reason: failureReason(xhr) }); });
        xhr.send(data);
      });
    }

    upload.addEventListener("submit", function (e) {
      if (!input.files || !input.files.length || !window.XMLHttpRequest || !window.FormData || !window.Promise) return;
      e.preventDefault();
      const files = Array.from(input.files);
      const total = files.reduce(function (s, f) { return s + f.size; }, 0) || 1;
      let sentBefore = 0;
      const failures = [];

      button.disabled = true;
      input.disabled = true;
      bar.hidden = false;
      errorList.hidden = true;
      errorList.innerHTML = "";

      // One photo per request, in order: each request stays small, and
      // one failure doesn't lose the others.
      files.reduce(function (chain, file, i) {
        return chain.then(function () {
          return sendOne(file, function (loaded) {
            bar.value = Math.round(((sentBefore + loaded) / total) * 100);
            info.textContent = "Uploading " + (i + 1) + " / " + files.length + "… " + bar.value + "%";
          }).then(function (result) {
            sentBefore += file.size;
            if (!result.ok) failures.push(file.name + ": " + result.reason);
          });
        });
      }, Promise.resolve()).then(function () {
        if (!failures.length) {
          window.location.href = upload.dataset.doneUrl;
          return;
        }
        const okCount = files.length - failures.length;
        info.innerHTML = "";
        info.append(okCount + " of " + files.length + " uploaded. ");
        const reload = document.createElement("a");
        reload.href = upload.dataset.doneUrl.replace(/\?notice=uploaded/, "");
        reload.textContent = "Reload the page";
        info.append(reload);
        failures.forEach(function (text) {
          const li = document.createElement("li");
          li.textContent = text;
          errorList.appendChild(li);
        });
        errorList.hidden = false;
        bar.hidden = true;
        button.disabled = false;
        input.disabled = false;
      });
    });
  }
})();
