/**
 * StackStepper Unified Shell Application Controller
 * Handles sliding navigation sidebar, state preservation, lab switching, and system health checks.
 */

window.StackStepperShell = (function () {
  'use strict';

  // DOM Element References
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const navItemCpp = document.getElementById('nav-item-cpp');
  const navItemSql = document.getElementById('nav-item-sql');
  const containerCpp = document.getElementById('container-cpp');
  const containerSql = document.getElementById('container-sql');
  const overlayCpp = document.getElementById('offline-overlay-cpp');
  const overlaySql = document.getElementById('offline-overlay-sql');
  const mobileHamburger = document.getElementById('mobile-hamburger');
  const drawerBackdrop = document.getElementById('drawer-backdrop');

  // Health Status Dots
  const dotCpp = document.querySelector('#health-cpp .health-dot');
  const dotSql = document.querySelector('#health-sql .health-dot');
  const dotMysql = document.querySelector('#health-mysql .health-dot');

  // Active state
  let currentLab = 'cpp';
  let healthCheckTimer = null;
  let isCheckingHealth = false;
  let currentMode = 'dark';
  let currentScheme = 'default';

  /**
   * Initialize StackStepper Shell
   */
  function init() {
    initThemeState();
    bindEvents();
    restoreSidebarState();
    startHealthMonitoring();
    console.log('[StackStepper Shell] Initialized successfully. Selected Lab:', currentLab);
  }

  /**
   * Initialize and restore Theme & Color Scheme
   */
  function initThemeState() {
    try {
      const savedMode = localStorage.getItem('stackstepper_mode');
      if (savedMode === 'light' || savedMode === 'dark') {
        currentMode = savedMode;
      }
      let savedScheme = localStorage.getItem('stackstepper_color_scheme');
      // Sanitize legacy entries
      if (savedScheme === 'default-dark' || savedScheme === 'default-light') savedScheme = 'default';
      if (savedScheme === 'github-dark' || savedScheme === 'github-light') savedScheme = 'github';
      if (savedScheme === 'vscode-dark') savedScheme = 'vscode';
      if (savedScheme === 'stackstepper-classic') savedScheme = 'stackstepper';
      if (savedScheme) {
        currentScheme = savedScheme;
      }
    } catch (e) {}

    applyTheme(currentMode, currentScheme);
  }

  function applyTheme(mode, scheme) {
    currentMode = mode;
    currentScheme = scheme;

    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.setAttribute('data-color-scheme', scheme);

    // Update UI toggle buttons
    const btnDark = document.getElementById('btn-theme-dark');
    const btnLight = document.getElementById('btn-theme-light');
    const selectScheme = document.getElementById('select-color-scheme');

    if (btnDark) btnDark.classList.toggle('active', mode === 'dark');
    if (btnLight) btnLight.classList.toggle('active', mode === 'light');
    if (selectScheme) selectScheme.value = scheme;

    try {
      localStorage.setItem('stackstepper_mode', mode);
      localStorage.setItem('stackstepper_color_scheme', scheme);
    } catch (e) {}

    // Broadcast theme change to lab iframes
    syncThemeToIframes(mode, scheme);
  }

  function syncThemeToIframes(mode, scheme) {
    const iframeCpp = document.getElementById('iframe-cpp');
    const iframeSql = document.getElementById('iframe-sql');

    const msg = { type: 'STACKSTEPPER_THEME_CHANGE', mode, scheme };

    if (iframeCpp && iframeCpp.contentWindow) {
      try { iframeCpp.contentWindow.postMessage(msg, '*'); } catch (e) {}
    }
    if (iframeSql && iframeSql.contentWindow) {
      try { iframeSql.contentWindow.postMessage(msg, '*'); } catch (e) {}
    }
  }

  /**
   * Bind event listeners for UI controls and keyboard shortcuts
   */
  function bindEvents() {
    // Sidebar Toggle
    sidebarToggle.addEventListener('click', toggleSidebar);

    // Lab Navigation Clicks
    navItemCpp.addEventListener('click', () => switchLab('cpp'));
    navItemSql.addEventListener('click', () => switchLab('sql'));

    // Theme Mode Controls
    const btnDark = document.getElementById('btn-theme-dark');
    const btnLight = document.getElementById('btn-theme-light');
    const selectScheme = document.getElementById('select-color-scheme');

    if (btnDark) btnDark.addEventListener('click', () => applyTheme('dark', currentScheme));
    if (btnLight) btnLight.addEventListener('click', () => applyTheme('light', currentScheme));
    if (selectScheme) selectScheme.addEventListener('change', (e) => applyTheme(currentMode, e.target.value));

    // Listen for iframe onload to sync theme
    const iframeCpp = document.getElementById('iframe-cpp');
    const iframeSql = document.getElementById('iframe-sql');
    if (iframeCpp) iframeCpp.addEventListener('load', () => syncThemeToIframes(currentMode, currentScheme));
    if (iframeSql) iframeSql.addEventListener('load', () => syncThemeToIframes(currentMode, currentScheme));

    // Mobile Hamburger & Backdrop
    if (mobileHamburger) {
      mobileHamburger.addEventListener('click', openMobileDrawer);
    }
    if (drawerBackdrop) {
      drawerBackdrop.addEventListener('click', closeMobileDrawer);
    }

    // Keyboard Shortcut (Ctrl + B / Cmd + B to toggle sidebar)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    });
  }

  /**
   * Toggle sidebar expanded / collapsed state
   */
  function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    try {
      localStorage.setItem('stackstepper_sidebar_collapsed', isCollapsed ? '1' : '0');
    } catch (e) {}
  }

  /**
   * Restore user's preferred sidebar state from localStorage
   */
  function restoreSidebarState() {
    try {
      const saved = localStorage.getItem('stackstepper_sidebar_collapsed');
      if (saved === '1') {
        sidebar.classList.add('collapsed');
      }
    } catch (e) {}
  }

  /**
   * Switch between C++ Memory Lab and SQL Engine Lab cleanly preserving view state
   */
  function switchLab(targetLab) {
    if (currentLab === targetLab) return;

    currentLab = targetLab;

    if (targetLab === 'cpp') {
      navItemCpp.classList.add('active');
      navItemSql.classList.remove('active');

      containerCpp.classList.add('active');
      containerSql.classList.remove('active');
    } else if (targetLab === 'sql') {
      navItemSql.classList.add('active');
      navItemCpp.classList.remove('active');

      containerSql.classList.add('active');
      containerCpp.classList.remove('active');
    }

    closeMobileDrawer();
    console.log(`[StackStepper Shell] Switched to ${targetLab.toUpperCase()} Lab.`);
  }

  /**
   * Mobile Drawer Handlers
   */
  function openMobileDrawer() {
    sidebar.classList.add('mobile-open');
    if (drawerBackdrop) drawerBackdrop.classList.add('active');
  }

  function closeMobileDrawer() {
    sidebar.classList.remove('mobile-open');
    if (drawerBackdrop) drawerBackdrop.classList.remove('active');
  }

  /**
   * Periodic Health Monitoring for C++, SQL Gateway, and MySQL services
   */
  function startHealthMonitoring() {
    checkHealth();
    healthCheckTimer = setInterval(checkHealth, 5000);
  }

  async function checkHealth() {
    if (isCheckingHealth) return;
    isCheckingHealth = true;

    try {
      // 1. Check C++ Stepper Backend (:3000)
      try {
        const res = await fetch('http://localhost:3000/api/health', { method: 'GET', signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          setHealthDot(dotCpp, 'online');
          overlayCpp.classList.add('hidden');
        } else {
          setHealthDot(dotCpp, 'offline');
          overlayCpp.classList.remove('hidden');
        }
      } catch (e) {
        setHealthDot(dotCpp, 'offline');
        // If server is on same domain, iframe is still responsive
        overlayCpp.classList.add('hidden');
      }

      // 2. Check SQL Gateway Backend (:18080)
      try {
        const res = await fetch('http://127.0.0.1:18080/api/health', { method: 'GET', signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          setHealthDot(dotSql, 'online');
          setHealthDot(dotMysql, 'online');
          overlaySql.classList.add('hidden');
        } else {
          setHealthDot(dotSql, 'offline');
          setHealthDot(dotMysql, 'offline');
          if (currentLab === 'sql') overlaySql.classList.remove('hidden');
        }
      } catch (e) {
        setHealthDot(dotSql, 'offline');
        setHealthDot(dotMysql, 'offline');
        if (currentLab === 'sql') overlaySql.classList.remove('hidden');
      }
    } finally {
      isCheckingHealth = false;
    }
  }

  function setHealthDot(dotElement, status) {
    if (!dotElement) return;
    dotElement.className = 'health-dot status-' + status;
  }

  // Public API
  return {
    init: init,
    switchLab: switchLab,
    toggleSidebar: toggleSidebar,
    checkHealth: checkHealth
  };

})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', window.StackStepperShell.init);
