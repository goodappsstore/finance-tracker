/**
 * Finance Tracker — Marketing Website JavaScript
 * Handles navigation, download modal, feature filtering/search, and interactive UI previews.
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. Mobile Menu Toggle
  const mobileToggle = document.querySelector(".mobile-toggle");
  const navMenu = document.querySelector(".nav-menu");

  if (mobileToggle && navMenu) {
    mobileToggle.addEventListener("click", () => {
      navMenu.classList.toggle("mobile-open");
      const isOpen = navMenu.classList.contains("mobile-open");
      mobileToggle.setAttribute("aria-expanded", isOpen);
      mobileToggle.innerHTML = isOpen ? "✕" : "☰";
    });
  }

  // 2. Download Modal Handlers
  const downloadModal = document.getElementById("download-modal");
  const openDownloadBtns = document.querySelectorAll(".js-open-download");
  const closeDownloadBtn = document.querySelector(".modal-close");

  function openModal() {
    if (downloadModal) {
      downloadModal.classList.add("active");
      document.body.style.overflow = "hidden";
    }
  }

  function closeModal() {
    if (downloadModal) {
      downloadModal.classList.remove("active");
      document.body.style.overflow = "";
    }
  }

  openDownloadBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
  });

  if (closeDownloadBtn) {
    closeDownloadBtn.addEventListener("click", closeModal);
  }

  if (downloadModal) {
    downloadModal.addEventListener("click", (e) => {
      if (e.target === downloadModal) {
        closeModal();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && downloadModal && downloadModal.classList.contains("active")) {
      closeModal();
    }
  });

  // 3. Interactive Mockup Tabs (on Homepage)
  const mockupTabBtns = document.querySelectorAll(".mockup-tab-btn");
  const mockupViews = {
    dashboard: {
      title: "Finance Tracker — Dashboard",
      kpi1Label: "Total Cash & Checking",
      kpi1Val: "$24,850.00",
      kpi1Sub: "+$3,420 this month",
      kpi2Label: "Net Worth",
      kpi2Val: "$182,400.00",
      kpi2Sub: "+8.4% YTD",
      kpi3Label: "Monthly Savings Rate",
      kpi3Val: "38.5%",
      kpi3Sub: "Ahead of target",
      bannerTitle: "Safe to spend before next payday",
      bannerDesc: "Calculated after reserving all bills, credit balances, and budget goals",
      bannerAmount: "$1,480.00",
      bannerSub: "$105.71 / day remaining"
    },
    budgets: {
      title: "Finance Tracker — Envelopes & Budgets",
      kpi1Label: "Allocated This Month",
      kpi1Val: "$4,200.00",
      kpi1Sub: "Across 14 categories",
      kpi2Label: "Spent So Far",
      kpi2Val: "$2,640.00",
      kpi2Sub: "62% of monthly cap",
      kpi3Label: "Rollover Surplus",
      kpi3Val: "+$340.00",
      kpi3Sub: "Carried from last month",
      bannerTitle: "Budget Health: All Envelopes On Track",
      bannerDesc: "Groceries and Dining out have surplus. Zero overspending.",
      bannerAmount: "$1,560.00",
      bannerSub: "Remaining budget available"
    },
    forecasting: {
      title: "Finance Tracker — 365-Day Cashflow Projection",
      kpi1Label: "Projected Low Point",
      kpi1Val: "$18,250.00",
      kpi1Sub: "Safe buffer maintained",
      kpi2Label: "Scheduled Bills",
      kpi2Val: "8 Recurring",
      kpi2Sub: "Next due in 4 days",
      kpi3Label: "12-Month Net Cashflow",
      kpi3Val: "+$42,800.00",
      kpi3Sub: "Based on baseline trends",
      bannerTitle: "Zero Cash Flow Breaches Detected",
      bannerDesc: "All upcoming insurance, tax, and mortgage commitments covered.",
      bannerAmount: "100% Safe",
      bannerSub: "Peace of mind projection"
    },
    networth: {
      title: "Finance Tracker — Assets & Liabilities",
      kpi1Label: "Liquid Assets",
      kpi1Val: "$38,400.00",
      kpi1Sub: "High-yield savings & cash",
      kpi2Label: "Investments & Equities",
      kpi2Val: "$165,800.00",
      kpi2Sub: "FIFO Cost basis tracked",
      kpi3Label: "Total Liabilities",
      kpi3Val: "-$21,800.00",
      kpi3Sub: "Mortgage & student loan",
      bannerTitle: "Debt-Free Milestone In Reach",
      bannerDesc: "Accelerated avalanche payoff will eliminate loan in 14 months.",
      bannerAmount: "$182,400.00",
      bannerSub: "Consolidated Net Worth"
    }
  };

  mockupTabBtns.forEach(tabBtn => {
    tabBtn.addEventListener("click", () => {
      mockupTabBtns.forEach(b => b.classList.remove("active"));
      tabBtn.classList.add("active");

      const viewKey = tabBtn.getAttribute("data-tab");
      const data = mockupViews[viewKey];
      if (!data) return;

      const titleEl = document.querySelector(".mockup-title span");
      const kpi1Lbl = document.querySelector("#mock-kpi-1 .kpi-label");
      const kpi1Val = document.querySelector("#mock-kpi-1 .kpi-val");
      const kpi1Sub = document.querySelector("#mock-kpi-1 .kpi-sub");

      const kpi2Lbl = document.querySelector("#mock-kpi-2 .kpi-label");
      const kpi2Val = document.querySelector("#mock-kpi-2 .kpi-val");
      const kpi2Sub = document.querySelector("#mock-kpi-2 .kpi-sub");

      const kpi3Lbl = document.querySelector("#mock-kpi-3 .kpi-label");
      const kpi3Val = document.querySelector("#mock-kpi-3 .kpi-val");
      const kpi3Sub = document.querySelector("#mock-kpi-3 .kpi-sub");

      const bannerTitle = document.querySelector(".safe-spend-info h4");
      const bannerDesc = document.querySelector(".safe-spend-info p");
      const bannerAmount = document.querySelector(".safe-spend-amount");
      const bannerSub = document.querySelector(".safe-spend-subtext");

      if (titleEl) titleEl.textContent = data.title;
      if (kpi1Lbl) kpi1Lbl.textContent = data.kpi1Label;
      if (kpi1Val) kpi1Val.textContent = data.kpi1Val;
      if (kpi1Sub) kpi1Sub.textContent = data.kpi1Sub;

      if (kpi2Lbl) kpi2Lbl.textContent = data.kpi2Label;
      if (kpi2Val) kpi2Val.textContent = data.kpi2Val;
      if (kpi2Sub) kpi2Sub.textContent = data.kpi2Sub;

      if (kpi3Lbl) kpi3Lbl.textContent = data.kpi3Label;
      if (kpi3Val) kpi3Val.textContent = data.kpi3Val;
      if (kpi3Sub) kpi3Sub.textContent = data.kpi3Sub;

      if (bannerTitle) bannerTitle.textContent = data.bannerTitle;
      if (bannerDesc) bannerDesc.textContent = data.bannerDesc;
      if (bannerAmount) bannerAmount.textContent = data.bannerAmount;
      if (bannerSub) bannerSub.textContent = data.bannerSub;
    });
  });

  // 4. FAQ Accordion
  const faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(item => {
    const questionBtn = item.querySelector(".faq-question");
    if (questionBtn) {
      questionBtn.addEventListener("click", () => {
        const isActive = item.classList.contains("active");
        faqItems.forEach(otherItem => otherItem.classList.remove("active"));
        if (!isActive) {
          item.classList.add("active");
        }
      });
    }
  });

  // 5. Feature Filter and Search on Features Page
  const filterPills = document.querySelectorAll(".filter-pill");
  const featureCards = document.querySelectorAll(".feature-detail-card");
  const featureSearch = document.getElementById("feature-search-input");
  const featureCountDisplay = document.getElementById("feature-count-display");

  let activeCategory = "all";
  let searchQuery = "";

  function applyFeatureFilters() {
    if (!featureCards.length) return;

    let visibleCount = 0;

    featureCards.forEach(card => {
      const cardCategories = (card.getAttribute("data-category") || "").toLowerCase().split(" ");
      const cardText = card.textContent.toLowerCase();

      const matchesCategory = activeCategory === "all" || cardCategories.includes(activeCategory);
      const matchesSearch = !searchQuery || cardText.includes(searchQuery);

      if (matchesCategory && matchesSearch) {
        card.style.display = "flex";
        visibleCount++;
      } else {
        card.style.display = "none";
      }
    });

    if (featureCountDisplay) {
      featureCountDisplay.textContent = `Showing ${visibleCount} of ${featureCards.length} features`;
    }
  }

  if (filterPills.length > 0) {
    filterPills.forEach(pill => {
      pill.addEventListener("click", () => {
        filterPills.forEach(p => p.classList.remove("active"));
        pill.classList.add("active");
        activeCategory = pill.getAttribute("data-filter") || "all";
        applyFeatureFilters();
      });
    });
  }

  if (featureSearch) {
    featureSearch.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      applyFeatureFilters();
    });
  }
});
