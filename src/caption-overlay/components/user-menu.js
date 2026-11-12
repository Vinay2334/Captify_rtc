// Hamburger button + user-menu popup for the subtitle window's top bar.
//
// createUserMenu({ onOpenChange }) -> { button, popup, open, close, toggle,
// destroy }. The popup is a second panel in the subtitle window's visual
// style, holding: account (Sign in / Sign out), quota usage, and user plan.
// All state comes from lib/user-store.js; all controls are the shadcn-style
// primitives from components/ui.js.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  function createUserMenu({ onOpenChange } = {}) {
    const { ui, icons, userStore } = NS;
    let isOpen = false;
    let destroyed = false;

    const button = ui.el("button", "captify-hamburger-btn");
    button.type = "button";
    button.title = "Menu";
    button.setAttribute("aria-label", "Open menu");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = icons.menu;

    const popup = ui.el("div", "captify-user-menu");
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Captify menu");

    function sectionLabel(icon, text) {
      const label = ui.el("div", "um-section-label");
      const span = ui.el("span");
      span.innerHTML = icon;
      label.append(span, ui.el("span", null, text));
      return label;
    }

    function render() {
      if (destroyed) return;
      const s = userStore.getState();
      const { usedMinutes: used, limitMinutes: limit } = s.quota;
      popup.replaceChildren();

      // Account
      const head = ui.el("div", "um-head");
      head.appendChild(ui.avatar(s.user?.initials || "G"));
      const headText = ui.el("div", "um-head-text");
      headText.append(
        ui.el("div", "um-name", s.user?.name || "Guest"),
        ui.el("div", "um-email", s.user?.email || "Not signed in"),
      );
      head.append(headText, ui.badge(s.plan.name, s.signedIn ? "default" : "secondary"));
      popup.appendChild(head);
      popup.appendChild(ui.el("div", "um-stack")).append(
        s.signedIn
          ? ui.button({ variant: "secondary", label: "Sign out", icon: icons.logOut, onClick: () => userStore.signOut() })
          : ui.button({ variant: "default", label: "Sign in", icon: icons.logIn, onClick: () => userStore.signIn() }),
      );

      // Quota
      popup.appendChild(ui.separator());
      popup.appendChild(sectionLabel(icons.gauge, "Quota"));
      const quotaRow = ui.el("div", "um-row");
      quotaRow.append(
        ui.el("span", "um-value", "Subtitle minutes"),
        ui.el("span", "um-value", `${used} / ${limit} min`),
      );
      popup.append(quotaRow, ui.progress(used, limit), ui.el("div", "um-muted", s.quota.resetsLabel));

      // User plan
      popup.appendChild(ui.separator());
      popup.appendChild(sectionLabel(icons.crown, "User plan"));
      const planRow = ui.el("div", "um-plan-row");
      const planText = ui.el("div");
      planText.append(
        ui.el("div", "um-value", `${s.plan.name} plan · ${s.plan.priceLabel}`),
        ui.el("div", "um-muted", s.plan.tagline),
      );
      planRow.append(planText, ui.badge(s.plan.name, "outline"));
      popup.appendChild(planRow);
      if (s.plan.name !== NS.userStore.getProPlan().name) {
        const upgrade = ui.el("div", "um-stack");
        upgrade.appendChild(ui.button({
          variant: "default", label: "Upgrade to Pro", icon: icons.zap,
          onClick: () => userStore.upgrade(),
        }));
        popup.appendChild(upgrade);
      }
    }

    function setOpen(next) {
      if (destroyed || next === isOpen) return;
      isOpen = next;
      popup.classList.toggle("is-open", isOpen);
      button.setAttribute("aria-expanded", String(isOpen));
      button.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
      onOpenChange?.(isOpen);
      if (isOpen) render();
    }

    button.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!isOpen); });
    button.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    popup.addEventListener("pointerdown", (e) => e.stopPropagation());
    popup.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); button.focus(); } });

    const unsubscribe = userStore.subscribe(render);
    userStore.load(render);
    render();

    return {
      button, popup,
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!isOpen),
      isOpen: () => isOpen,
      destroy() { destroyed = true; unsubscribe(); setOpen(false); },
    };
  }

  NS.createUserMenu = createUserMenu;
})();
