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

    upload.addEventListener("submit", function (e) {
      if (!input.files || !input.files.length || !window.XMLHttpRequest || !window.FormData) return;
      e.preventDefault();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", upload.action);
      xhr.upload.addEventListener("progress", function (ev) {
        if (ev.lengthComputable) {
          bar.value = Math.round((ev.loaded / ev.total) * 100);
          info.textContent = "Uploading… " + bar.value + "%";
        }
      });
      xhr.addEventListener("load", function () {
        // The server answers with a redirect back to this page.
        window.location.href = xhr.responseURL || window.location.href;
      });
      xhr.addEventListener("error", function () {
        info.textContent = "Upload failed - check your connection and try again.";
        button.disabled = false;
        bar.hidden = true;
      });
      button.disabled = true;
      bar.hidden = false;
      xhr.send(new FormData(upload));
    });
  }
})();
