// Custom dropdown used by the subtitle top bar (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  NS.makeDropdown = function(options, defaultCode, labelText, onChange, showBadge = true) {
    let selectedCode = defaultCode;
    let isOpen = false;

    const field = document.createElement("div");
    field.className = "dd-field";

    const label = document.createElement("span");
    label.className = "dd-label";
    label.textContent = labelText;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const triggerText = document.createElement("span");
    triggerText.className = "dd-trigger-text";

    const chevron = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    chevron.setAttribute("viewBox", "0 0 20 20");
    chevron.setAttribute("fill", "currentColor");
    chevron.classList.add("dd-chevron");
    chevron.innerHTML = `<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />`;

    trigger.appendChild(triggerText);
    trigger.appendChild(chevron);

    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");

    const optionEls = new Map();

    function updateTriggerUI() {
      const entry = options.find(([c]) => c === selectedCode) || options[0];
      triggerText.innerHTML = showBadge
        ? `<span class="dd-badge">${entry[0]}</span><span>${entry[1]}</span>`
        : `<span>${entry[1]}</span>`;
      optionEls.forEach((el, code) => {
        el.classList.toggle("is-selected", code === selectedCode);
      });
    }

    function openMenu() {
      if (isOpen) return;
      isOpen = true;
      field.classList.add("is-open");
      S.container?.classList.add("menu-open");
      trigger.setAttribute("aria-expanded", "true");
      const activeEl = optionEls.get(selectedCode);
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }

    function closeMenu() {
      if (!isOpen) return;
      isOpen = false;
      field.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      if (S.shadow && !S.shadow.querySelector(".dd-field.is-open")) {
        S.container?.classList.remove("menu-open");
      }
    }

    function selectCode(code) {
      if (code === selectedCode) {
        closeMenu();
        return;
      }
      selectedCode = code;
      updateTriggerUI();
      closeMenu();
      onChange(selectedCode);
    }

    for (const [code, name] of options) {
      const opt = document.createElement("div");
      opt.className = "dd-option";
      opt.setAttribute("role", "option");
      opt.innerHTML = `
        <span class="dd-option-left">
          ${showBadge ? `<span class="dd-badge">${code}</span>` : ""}
          <span>${name}</span>
        </span>
        <svg class="dd-check" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
        </svg>
      `;
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        selectCode(code);
      });
      optionEls.set(code, opt);
      menu.appendChild(opt);
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      S.shadow?.querySelectorAll(".dd-field.is-open").forEach((el) => {
        if (el !== field) el.dispatchEvent(new CustomEvent("close-dd"));
      });
      isOpen ? closeMenu() : openMenu();
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenu();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) openMenu();
        const idx = options.findIndex(([c]) => c === selectedCode);
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(options.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        selectCode(options[nextIdx][0]);
      }
    });

    field.addEventListener("close-dd", closeMenu);

    updateTriggerUI();
    field.appendChild(label);
    field.appendChild(trigger);
    field.appendChild(menu);

    return {
      el: field,
      getValue: () => selectedCode,
      close: closeMenu,
    };
  }
})();
