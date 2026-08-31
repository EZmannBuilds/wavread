document.documentElement.classList.add("js");

const navToggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");

if (navToggle && navLinks) {
  const closeNavigation = () => {
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.querySelector(".sr-only").textContent = "Open navigation";
    navLinks.classList.remove("is-open");
  };

  navToggle.addEventListener("click", () => {
    const willOpen = navToggle.getAttribute("aria-expanded") !== "true";
    navToggle.setAttribute("aria-expanded", String(willOpen));
    navToggle.querySelector(".sr-only").textContent = willOpen ? "Close navigation" : "Open navigation";
    navLinks.classList.toggle("is-open", willOpen);
  });

  navLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeNavigation();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeNavigation();
      navToggle.focus();
    }
  });
}

const revealItems = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

// Copy buttons: [data-copy] names the element whose text to put on the clipboard.
// An inline handler would be blocked by the site's CSP (script-src 'self'), so it
// lives here. Clipboard access needs a secure context, and the site is served over
// HTTPS — but a local file:// or http:// preview is not, so the failure path
// selects the text instead of silently doing nothing.
document.querySelectorAll(".copy").forEach((button) => {
  const restore = () => {
    button.textContent = "Copy";
    button.removeAttribute("data-done");
  };
  button.addEventListener("click", () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const selectInstead = () => {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Select + copy";
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) return selectInstead();
    navigator.clipboard.writeText(source.textContent).then(() => {
      button.textContent = "Copied";
      button.dataset.done = "1";
      setTimeout(restore, 1600);
    }, selectInstead);
  });
});
