/* Mobile hamburger navigation — shared across all pages */
(function () {
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("main-nav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", function () {
    toggle.classList.toggle("active");
    nav.classList.toggle("open");
  });

  // Close menu when a link is tapped
  nav.addEventListener("click", function (e) {
    if (e.target.classList.contains("nav-link")) {
      toggle.classList.remove("active");
      nav.classList.remove("open");
    }
  });
})();
