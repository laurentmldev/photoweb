(function () {
  function getGalleryImages(root) {
    var script = root.querySelector(".gallery-data");
    if (!script) return [];
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      return [];
    }
  }

  // ---------------------------------------------------------------------
  // Lightbox: shared single overlay, opened by any gallery on the page.
  // ---------------------------------------------------------------------
  var lightboxEl, lightboxImg, lightboxTitle, lightboxText, lightboxCounter, lightboxPrev, lightboxNext, lightboxClose;
  var currentImages = [];
  var currentIndex = 0;

  function setupLightbox() {
    lightboxEl = document.getElementById("lightbox");
    if (!lightboxEl) return;
    lightboxImg = lightboxEl.querySelector(".lightbox-image");
    lightboxTitle = lightboxEl.querySelector(".lightbox-title");
    lightboxText = lightboxEl.querySelector(".lightbox-text");
    lightboxCounter = lightboxEl.querySelector(".lightbox-counter");
    lightboxPrev = lightboxEl.querySelector(".lightbox-prev");
    lightboxNext = lightboxEl.querySelector(".lightbox-next");
    lightboxClose = lightboxEl.querySelector(".lightbox-close");

    lightboxClose.addEventListener("click", closeLightbox);
    lightboxEl.addEventListener("click", function (e) {
      if (e.target === lightboxEl) closeLightbox();
    });
    lightboxPrev.addEventListener("click", function () { showLightbox(currentIndex - 1); });
    lightboxNext.addEventListener("click", function () { showLightbox(currentIndex + 1); });

    document.addEventListener("keydown", function (e) {
      if (lightboxEl.hasAttribute("hidden")) return;
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") showLightbox(currentIndex - 1);
      if (e.key === "ArrowRight") showLightbox(currentIndex + 1);
    });
  }

  function openLightbox(images, index) {
    if (!lightboxEl || !images || images.length === 0) return;
    currentImages = images;
    showLightbox(index);
    lightboxEl.removeAttribute("hidden");
    document.body.classList.add("lightbox-open");
  }

  function showLightbox(index) {
    if (currentImages.length === 0) return;
    currentIndex = (index + currentImages.length) % currentImages.length;
    var img = currentImages[currentIndex];
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt || "";
    // Title (e.g. Lightroom "Title") as a heading and caption below; a
    // photo with neither shows its alt text (gallery name - file name).
    var hasMetadata = img.title || img.caption;
    lightboxTitle.textContent = img.title || "";
    lightboxText.textContent = hasMetadata ? img.caption || "" : img.alt || "";
    var multi = currentImages.length > 1;
    if (lightboxCounter) lightboxCounter.textContent = multi ? (currentIndex + 1) + " / " + currentImages.length : "";
    // Warm the cache for the neighbours, so stepping through a big
    // gallery doesn't wait on each photo.
    if (multi) {
      [currentIndex + 1, currentIndex - 1].forEach(function (i) {
        new Image().src = currentImages[(i + currentImages.length) % currentImages.length].src;
      });
    }
    lightboxPrev.style.display = multi ? "" : "none";
    lightboxNext.style.display = multi ? "" : "none";
  }

  function closeLightbox() {
    lightboxEl.setAttribute("hidden", "");
    lightboxImg.src = "";
    document.body.classList.remove("lightbox-open");
  }

  // ---------------------------------------------------------------------
  // Slideshow: auto-rotates every `data-interval` seconds (from the
  // gallery's YAML config, default 3s), plus manual arrows/dots. Clicking
  // a slide opens it in the lightbox instead of just sitting there.
  // ---------------------------------------------------------------------
  function initSlideshow(root) {
    var images = getGalleryImages(root);

    root.querySelectorAll(".slide-trigger").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openLightbox(images, Number(btn.dataset.index));
      });
    });

    var slides = Array.prototype.slice.call(root.querySelectorAll(".slide"));
    var dots = Array.prototype.slice.call(root.querySelectorAll(".slide-dot"));
    var prevBtn = root.querySelector(".slide-prev");
    var nextBtn = root.querySelector(".slide-next");
    // Big galleries: progress bar + counter instead of one dot per photo.
    var track = root.querySelector(".slide-progress-track");
    var fill = root.querySelector(".slide-progress-fill");
    var counter = root.querySelector(".slide-counter");
    if (slides.length <= 1) return;

    // Photos other than the first carry data-src and are only loaded when
    // they (or a neighbour) become current.
    function ensureLoaded(index) {
      var img = slides[(index + slides.length) % slides.length].querySelector("img[data-src]");
      if (img) {
        img.src = img.dataset.src;
        img.removeAttribute("data-src");
      }
    }
    ensureLoaded(1);
    ensureLoaded(-1);

    var current = 0;
    var intervalSeconds = parseFloat(root.dataset.interval);
    var AUTOPLAY_MS = (!isNaN(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 3) * 1000;
    var timer = null;

    function show(index) {
      slides[current].classList.remove("is-active");
      if (dots[current]) dots[current].classList.remove("is-active");
      current = (index + slides.length) % slides.length;
      ensureLoaded(current);
      ensureLoaded(current + 1);
      ensureLoaded(current - 1);
      slides[current].classList.add("is-active");
      if (dots[current]) dots[current].classList.add("is-active");
      if (fill) fill.style.width = ((current + 1) / slides.length) * 100 + "%";
      if (counter) counter.textContent = (current + 1) + " / " + slides.length;
      if (track) track.setAttribute("aria-valuenow", current + 1);
    }

    function next() { show(current + 1); }
    function prev() { show(current - 1); }

    function startAutoplay() {
      stopAutoplay();
      timer = setInterval(next, AUTOPLAY_MS);
    }
    function stopAutoplay() {
      if (timer) clearInterval(timer);
    }

    if (nextBtn) nextBtn.addEventListener("click", function (e) { e.stopPropagation(); next(); startAutoplay(); });
    if (prevBtn) prevBtn.addEventListener("click", function (e) { e.stopPropagation(); prev(); startAutoplay(); });
    dots.forEach(function (dot, i) {
      dot.addEventListener("click", function (e) {
        e.stopPropagation();
        show(i);
        startAutoplay();
      });
    });

    if (track) {
      // Click/tap anywhere on the bar to jump to that point of the gallery.
      track.addEventListener("click", function (e) {
        e.stopPropagation();
        var rect = track.getBoundingClientRect();
        var ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 0.9999);
        show(Math.floor(ratio * slides.length));
        startAutoplay();
      });
      track.addEventListener("keydown", function (e) {
        var step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1,
                     PageUp: 10, PageDown: -10 }[e.key];
        if (e.key === "Home") step = -current;
        if (e.key === "End") step = slides.length - 1 - current;
        if (step === undefined) return;
        e.preventDefault();
        show(current + step);
        startAutoplay();
      });
    }

    root.addEventListener("mouseenter", stopAutoplay);
    root.addEventListener("mouseleave", startAutoplay);

    startAutoplay();
  }

  // ---------------------------------------------------------------------
  // Thumbnails: clicking a thumbnail opens it in the lightbox overlay.
  // ---------------------------------------------------------------------
  function initThumbnails(root) {
    var images = getGalleryImages(root);
    root.querySelectorAll(".thumbnail").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openLightbox(images, Number(btn.dataset.index));
      });
    });
  }

  // Discourage saving photos: no right-click "Save image as..." menu and
  // no dragging images out of the page, on every page of the site. This
  // only deters casual copying - anything a browser displays can still be
  // captured (screenshots, developer tools).
  function isImage(target) {
    return target && target.tagName === "IMG";
  }
  document.addEventListener("contextmenu", function (e) {
    if (isImage(e.target)) e.preventDefault();
  });
  document.addEventListener("dragstart", function (e) {
    if (isImage(e.target)) e.preventDefault();
  });

  document.addEventListener("DOMContentLoaded", function () {
    setupLightbox();
    document.querySelectorAll('[data-component="slideshow"]').forEach(initSlideshow);
    document.querySelectorAll('[data-component="thumbnails"]').forEach(initThumbnails);
  });
})();
