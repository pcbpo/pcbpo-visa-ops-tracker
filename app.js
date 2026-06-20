// PCBPO Visa Operations Tracker — App logic

const LOGO_URL = "logo.png"; // see note in README — drop your logo file here

let clientDepartments = [];
let employeeFields = [];
let sharedEntries = {};
let isSignupMode = false;

// ---------- bootstrap ----------

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("navLogo").src = LOGO_URL;
  document.getElementById("loginLogo").src = LOGO_URL;

  wireLoginEvents();
  wireStaffEvents();

  const session = await Auth.getSession();
  if (session) {
    try {
      const employee = await Auth.loadEmployeeProfile(session.user.id);
      if (employee.is_manager) {
        await showManagerScreen();
      } else {
        await Auth.recordInTimeIfNeeded(session.user.id);
        await showStaffScreen();
      }
    } catch (e) {
      showLoginError(e.message);
      await supabaseClient.auth.signOut();
    }
  }
});

// ---------- login screen ----------

function wireLoginEvents() {
  document.getElementById("toggleToSignup").querySelector("a").onclick = () => setSignupMode(true);
  document.getElementById("toggleToLogin").querySelector("a").onclick = () => setSignupMode(false);

  document.getElementById("loginBtn").onclick = handleLogin;
  document.getElementById("signupBtn").onclick = handleSignup;
  document.getElementById("navLogoutBtn").onclick = handleLogout;
}

function setSignupMode(on) {
  isSignupMode = on;
  document.getElementById("signupNameRow").classList.toggle("hidden", !on);
  document.getElementById("loginBtn").classList.toggle("hidden", on);
  document.getElementById("signupBtn").classList.toggle("hidden", !on);
  document.getElementById("toggleToSignup").classList.toggle("hidden", on);
  document.getElementById("toggleToLogin").classList.toggle("hidden", !on);
  hideLoginError();
}

function showLoginError(msg) {
  const el = document.getElementById("loginError");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideLoginError() {
  document.getElementById("loginError").classList.add("hidden");
}

async function handleLogin() {
  hideLoginError();
  const email = document.getElementById("emailInput").value.trim();
  const password = document.getElementById("passwordInput").value;
  if (!email || !password) {
    showLoginError("Enter your office email and password.");
    return;
  }
  try {
    const { user } = await Auth.signIn(email, password);
    if (Auth.currentEmployee.is_manager) {
      await showManagerScreen();
    } else {
      await Auth.recordInTimeIfNeeded(user.id);
      await showStaffScreen();
    }
  } catch (e) {
    showLoginError(e.message || "Couldn't log in. Check your email and password.");
  }
}

async function handleSignup() {
  hideLoginError();
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("emailInput").value.trim();
  const password = document.getElementById("passwordInput").value;
  if (!name || !email || !password) {
    showLoginError("Fill in your name, office email, and a password.");
    return;
  }
  if (password.length < 6) {
    showLoginError("Password should be at least 6 characters.");
    return;
  }
  try {
    await Auth.signUp(email, password, name);
    showLoginError(
      "Account created. Ask your manager to link this email to your staff record, then log in."
    );
    setSignupMode(false);
  } catch (e) {
    showLoginError(e.message || "Couldn't create account.");
  }
}

async function handleLogout() {
  await Auth.signOut();
  document.getElementById("staffScreen").classList.add("hidden");
  document.getElementById("summaryScreen").classList.add("hidden");
  document.getElementById("managerScreen").classList.add("hidden");
  document.getElementById("navUserBox").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("emailInput").value = "";
  document.getElementById("passwordInput").value = "";
}

// ---------- staff entry screen ----------

async function showStaffScreen() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("staffScreen").classList.remove("hidden");
  document.getElementById("navUserBox").classList.remove("hidden");
  document.getElementById("navUserName").textContent = Auth.currentEmployee.full_name;

  document.getElementById("staffName").textContent = Auth.currentEmployee.full_name;
  document.getElementById("staffRole").textContent = Auth.currentEmployee.role;

  const attendance = await Data.getTodayAttendance(Auth.currentEmployee.id);
  document.getElementById("staffInTime").textContent = attendance?.in_time
    ? formatTime(attendance.in_time)
    : "—";

  clientDepartments = await Data.getClientDepartments();
  employeeFields = await Data.getFieldsForEmployee(Auth.currentEmployee);
  sharedEntries = await Data.getTodaySharedEntries();
  const todayByDept = await Data.getTodayTotalsByDepartment(Auth.currentEmployee.id);

  renderIndividualFields(todayByDept);
  renderSharedFields();
  updateEntryCountFromByDept(todayByDept);
}

function deptName(deptId) {
  const d = clientDepartments.find((x) => x.id === deptId);
  return d ? d.name : "—";
}

function deptOptionsHtml(excludeIds = []) {
  return clientDepartments
    .filter((d) => !excludeIds.includes(d.id))
    .map((d) => `<option value="${d.id}">${d.name}</option>`)
    .join("");
}

function renderIndividualFields(todayByDept) {
  const container = document.getElementById("individualFieldsContainer");
  const individual = employeeFields.filter((f) => f.entry_mode === "individual");

  if (individual.length === 0) {
    container.innerHTML = `<p style="font-size:13px;color:var(--gray);">No individual fields assigned. Contact your manager if this looks wrong.</p>`;
    return;
  }

  container.innerHTML = `<div class="section-label">Your individual work today</div>`;

  const groups = {};
  individual.forEach((f) => {
    const g = f.field_group || "General";
    groups[g] = groups[g] || [];
    groups[g].push(f);
  });

  for (const [groupName, fields] of Object.entries(groups)) {
    const groupDiv = document.createElement("div");
    groupDiv.className = "field-group";
    groupDiv.innerHTML = `<div class="group-label">${groupName}</div>`;

    fields.forEach((f) => {
      groupDiv.appendChild(buildFieldCard(f, todayByDept[f.id] || {}));
    });
    container.appendChild(groupDiv);
  }
}

function buildFieldCard(field, deptTotals) {
  const card = document.createElement("div");
  card.className = "field-card";
  card.style.flexDirection = "column";
  card.style.alignItems = "stretch";
  card.dataset.fieldCard = field.id;

  const grandTotal = Object.values(deptTotals).reduce((s, v) => s + v, 0);

  if (!field.requires_client_dept) {
    // Simple case: no department breakdown needed at all (e.g. petty cash counts).
    card.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <span class="field-label">${field.field_label}</span>
        <div class="field-controls">
          <input type="number" min="0" value="${grandTotal}" data-field-input="${field.id}" data-dept="__none__" />
          <button class="btn-tap" data-bump="${field.id}" data-dept="__none__" data-amount="1">+1</button>
          <button class="btn-tap" data-bump="${field.id}" data-dept="__none__" data-amount="5">+5</button>
        </div>
      </div>
    `;
    wireFieldCardEvents(card);
    return card;
  }

  const touchedDeptIds = Object.keys(deptTotals).filter((k) => k !== "__none__");
  const rowsHtml = touchedDeptIds
    .map(
      (deptId) => `
      <div class="dept-row" data-dept-row="${deptId}" style="display:flex; justify-content:space-between; align-items:center; padding:6px 0;">
        <span style="font-size:13px;">${deptName(deptId)}</span>
        <div style="display:flex; align-items:center; gap:6px;">
          <input type="number" min="0" value="${deptTotals[deptId]}" style="width:56px; text-align:right;" data-field-input="${field.id}" data-dept="${deptId}" />
          <button class="btn-tap" data-bump="${field.id}" data-dept="${deptId}" data-amount="1">+1</button>
        </div>
      </div>
    `
    )
    .join("");

  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span class="field-label">${field.field_label}</span>
      <span style="font-size:18px; font-weight:500;" data-field-total="${field.id}">${grandTotal}</span>
    </div>
    ${
      touchedDeptIds.length > 0
        ? `<div style="font-size:11px; color:var(--gray); margin:2px 0 8px;">across ${touchedDeptIds.length} department${touchedDeptIds.length > 1 ? "s" : ""} today</div>`
        : ""
    }
    <div data-dept-rows-container="${field.id}" style="border-top:${touchedDeptIds.length > 0 ? "1px solid var(--border)" : "none"}; padding-top:${touchedDeptIds.length > 0 ? "6px" : "0"};">
      ${rowsHtml}
    </div>
    <div style="padding-top:8px;">
      <select class="dept-select" data-add-dept="${field.id}" style="width:100%;">
        <option value="">+ Add a department…</option>
        ${deptOptionsHtml(touchedDeptIds)}
      </select>
    </div>
  `;

  wireFieldCardEvents(card);
  return card;
}

function wireFieldCardEvents(card) {
  card.querySelectorAll("[data-bump]").forEach((btn) => {
    btn.onclick = () =>
      handleBump(btn.dataset.bump, btn.dataset.dept, parseInt(btn.dataset.amount, 10));
  });
  card.querySelectorAll("[data-field-input]").forEach((input) => {
    input.onchange = () =>
      handleManualSet(input.dataset.fieldInput, input.dataset.dept, input.value);
  });
  const addDeptSelect = card.querySelector("[data-add-dept]");
  if (addDeptSelect) {
    addDeptSelect.onchange = () => {
      const fieldId = addDeptSelect.dataset.addDept;
      const deptId = addDeptSelect.value;
      if (!deptId) return;
      addDeptRowToCard(fieldId, deptId, 0);
      addDeptSelect.value = "";
    };
  }
}

// Adds a new department row to an already-rendered field card, without
// a full re-render — keeps typing/tapping elsewhere on the screen
// uninterrupted.
function addDeptRowToCard(fieldId, deptId, initialValue) {
  const container = document.querySelector(`[data-dept-rows-container="${fieldId}"]`);
  if (!container) return;
  if (container.querySelector(`[data-dept-row="${deptId}"]`)) return; // already present

  container.style.borderTop = "1px solid var(--border)";
  container.style.paddingTop = "6px";

  const row = document.createElement("div");
  row.className = "dept-row";
  row.dataset.deptRow = deptId;
  row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:6px 0;";
  row.innerHTML = `
    <span style="font-size:13px;">${deptName(deptId)}</span>
    <div style="display:flex; align-items:center; gap:6px;">
      <input type="number" min="0" value="${initialValue}" style="width:56px; text-align:right;" data-field-input="${fieldId}" data-dept="${deptId}" />
      <button class="btn-tap" data-bump="${fieldId}" data-dept="${deptId}" data-amount="1">+1</button>
    </div>
  `;
  container.appendChild(row);
  row.querySelector("[data-bump]").onclick = () => handleBump(fieldId, deptId, 1);
  row.querySelector("[data-field-input]").onchange = (e) =>
    handleManualSet(fieldId, deptId, e.target.value);

  // remove that department from the "add" dropdown's options
  const addSelect = document.querySelector(`[data-add-dept="${fieldId}"]`);
  if (addSelect) {
    const opt = addSelect.querySelector(`option[value="${deptId}"]`);
    if (opt) opt.remove();
  }

  updateFieldCardSubtotal(fieldId);
}

function updateFieldCardSubtotal(fieldId) {
  const card = document.querySelector(`[data-field-card="${fieldId}"]`);
  if (!card) return;
  const inputs = card.querySelectorAll(`[data-field-input="${fieldId}"]`);
  let total = 0;
  inputs.forEach((inp) => (total += parseInt(inp.value, 10) || 0));
  const totalSpan = card.querySelector(`[data-field-total="${fieldId}"]`);
  if (totalSpan) totalSpan.textContent = total;

  const deptCount = card.querySelectorAll("[data-dept-row]").length;
  const subtitle = card.querySelector("div[style*='margin:2px 0 8px']");
  // subtitle text isn't critical to keep perfectly live; full re-render on next screen load corrects it
}

async function handleBump(fieldId, deptKey, amount) {
  const deptId = deptKey === "__none__" ? null : deptKey;
  try {
    await Data.logIncrement(Auth.currentEmployee.id, fieldId, deptId, amount);
    const input = document.querySelector(`[data-field-input="${fieldId}"][data-dept="${deptKey}"]`);
    if (input) input.value = (parseInt(input.value, 10) || 0) + amount;
    updateFieldCardSubtotal(fieldId);
    refreshEntryCount();
  } catch (e) {
    alert("Couldn't save: " + e.message);
  }
}

async function handleManualSet(fieldId, deptKey, rawValue) {
  const amount = Math.max(0, parseInt(rawValue, 10) || 0);
  const deptId = deptKey === "__none__" ? null : deptKey;
  try {
    await Data.setManualValue(Auth.currentEmployee.id, fieldId, deptId, amount);
    updateFieldCardSubtotal(fieldId);
    refreshEntryCount();
  } catch (e) {
    alert("Couldn't save: " + e.message);
  }
}

function renderSharedFields() {
  const container = document.getElementById("sharedFieldsContainer");
  const shared = employeeFields.filter((f) => f.entry_mode === "shared_batch");
  container.innerHTML = "";

  shared.forEach((f) => {
    const entry = sharedEntries[f.id];
    const card = document.createElement("div");
    card.className = "shared-card" + (entry ? " logged" : "");

    if (entry) {
      card.innerHTML = `
        <div class="shared-top">
          <span class="field-label">${f.field_label}</span>
          <span class="shared-value">${entry.amount}</span>
        </div>
        <div class="shared-meta">
          Logged by ${entry.employees?.full_name || "—"}, ${formatTime(entry.created_at)}
          &nbsp;·&nbsp; <a data-correct="${f.id}">Request correction</a>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="shared-top">
          <span class="field-label">${f.field_label}</span>
        </div>
        <div class="shared-entry-row">
          <span style="font-size:12px;color:var(--gray);">Not yet logged today.</span>
          ${f.requires_client_dept ? `<select data-shared-dept="${f.id}">${deptOptionsHtml()}</select>` : ""}
          <input type="number" placeholder="e.g. 100" data-shared-input="${f.id}" />
          <button class="btn-log" data-shared-submit="${f.id}">Log it</button>
        </div>
      `;
    }
    container.appendChild(card);
  });

  container.querySelectorAll("[data-shared-submit]").forEach((btn) => {
    btn.onclick = () => handleSharedSubmit(btn.dataset.sharedSubmit);
  });
  container.querySelectorAll("[data-correct]").forEach((link) => {
    link.onclick = () => handleSharedCorrection(link.dataset.correct);
  });
}

async function handleSharedSubmit(fieldId) {
  const input = document.querySelector(`[data-shared-input="${fieldId}"]`);
  const deptSelect = document.querySelector(`[data-shared-dept="${fieldId}"]`);
  const amount = parseInt(input.value, 10);
  if (!amount || amount <= 0) {
    alert("Enter a number greater than 0.");
    return;
  }
  try {
    await Data.logSharedBatch(
      Auth.currentEmployee.id,
      fieldId,
      deptSelect ? deptSelect.value : null,
      amount
    );
    sharedEntries = await Data.getTodaySharedEntries();
    renderSharedFields();
  } catch (e) {
    alert(e.message);
    sharedEntries = await Data.getTodaySharedEntries();
    renderSharedFields();
  }
}

async function handleSharedCorrection(fieldId) {
  const existing = sharedEntries[fieldId];
  const newVal = prompt(
    `Current value: ${existing.amount}, logged by ${existing.employees?.full_name}.\nEnter corrected number:`
  );
  if (newVal === null) return;
  const amount = parseInt(newVal, 10);
  if (!amount || amount <= 0) {
    alert("Enter a valid number.");
    return;
  }
  try {
    await Data.correctSharedBatch(
      Auth.currentEmployee.id,
      fieldId,
      existing.client_dept_id || null,
      amount,
      existing.id
    );
    sharedEntries = await Data.getTodaySharedEntries();
    renderSharedFields();
  } catch (e) {
    alert("Couldn't save correction: " + e.message);
  }
}

function updateEntryCount(todayTotals) {
  const total = Object.values(todayTotals).reduce((s, v) => s + v, 0);
  document.getElementById("entryCount").textContent = `${total} total entries logged today`;
}

function updateEntryCountFromByDept(todayByDept) {
  let total = 0;
  for (const fieldTotals of Object.values(todayByDept)) {
    total += Object.values(fieldTotals).reduce((s, v) => s + v, 0);
  }
  document.getElementById("entryCount").textContent = `${total} total entries logged today`;
}

async function refreshEntryCount() {
  const totals = await Data.getTodayTotals(Auth.currentEmployee.id);
  updateEntryCount(totals);
}

// ---------- logout summary ----------

function wireStaffEvents() {
  document.getElementById("logOffBtn").onclick = handleLogOffWithSummary;
  document.getElementById("backToEntryBtn").onclick = () => {
    document.getElementById("summaryScreen").classList.add("hidden");
    document.getElementById("staffScreen").classList.remove("hidden");
  };
}

async function handleLogOffWithSummary() {
  const note = document.getElementById("noteBox").value.trim();
  const extraWork = document.getElementById("extraWorkBox").value.trim();
  if (note || extraWork) {
    try {
      await Data.saveNote(Auth.currentEmployee.id, note, extraWork);
    } catch (e) {
      console.error("Couldn't save note:", e);
    }
  }

  const todayTotals = await Data.getTodayTotals(Auth.currentEmployee.id);
  const attendance = await Data.getTodayAttendance(Auth.currentEmployee.id);

  await Auth.recordOutTime(Auth.currentEmployee.id);

  document.getElementById("summaryGreeting").textContent =
    `Nice work today, ${Auth.currentEmployee.full_name}.`;
  const inT = attendance?.in_time ? formatTime(attendance.in_time) : "—";
  const outT = formatTime(new Date().toISOString());
  document.getElementById("summaryTimes").textContent = `In: ${inT}  ·  Out: ${outT}`;

  const rowsContainer = document.getElementById("summaryRows");
  rowsContainer.innerHTML = "";
  const individual = employeeFields.filter((f) => f.entry_mode === "individual");
  individual.forEach((f) => {
    const val = todayTotals[f.id] || 0;
    const row = document.createElement("div");
    row.className = "summary-row";
    row.innerHTML = `<span>${f.field_label}</span><span style="font-weight:500;">${val}</span>`;
    rowsContainer.appendChild(row);
  });

  const noteBox = document.getElementById("summaryNoteBox");
  const noteLines = [];
  if (extraWork) noteLines.push("Additional work today: " + extraWork);
  if (note) noteLines.push("Note: " + note);
  if (noteLines.length > 0) {
    noteBox.innerHTML = noteLines.map((l) => `<div>${l}</div>`).join("");
    noteBox.classList.remove("hidden");
  } else {
    noteBox.classList.add("hidden");
  }

  document.getElementById("staffScreen").classList.add("hidden");
  document.getElementById("summaryScreen").classList.remove("hidden");
}

// ---------- helpers ----------

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------- manager dashboard ----------

let managerTabsWired = false;

async function showManagerScreen() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("staffScreen").classList.add("hidden");
  document.getElementById("summaryScreen").classList.add("hidden");
  document.getElementById("managerScreen").classList.remove("hidden");
  document.getElementById("navUserBox").classList.remove("hidden");
  document.getElementById("navUserName").textContent = Auth.currentEmployee.full_name;

  document.getElementById("mgrDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  if (!managerTabsWired) {
    document.querySelectorAll("[data-mgr-tab]").forEach((btn) => {
      btn.onclick = () => switchManagerTab(btn.dataset.mgrTab);
    });
    managerTabsWired = true;
  }

  await loadManagerToday();
}

function switchManagerTab(tab) {
  document.querySelectorAll("[data-mgr-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mgrTab === tab);
  });
  document.getElementById("mgrTodayPanel").classList.toggle("hidden", tab !== "today");
  document.getElementById("mgrTrendsPanel").classList.toggle("hidden", tab !== "trends");
  document.getElementById("mgrMonthlyPanel").classList.toggle("hidden", tab !== "monthly");
  document.getElementById("mgrAlertsPanel").classList.toggle("hidden", tab !== "alerts");

  if (tab === "today") loadManagerToday();
  if (tab === "trends") loadManagerTrends();
  if (tab === "monthly") loadManagerMonthly();
  if (tab === "alerts") loadManagerAlerts();
}

async function loadManagerToday() {
  const metricsContainer = document.getElementById("mgrMetrics");
  metricsContainer.innerHTML = `<div class="mgr-loading">Loading today's numbers…</div>`;

  try {
    const metrics = await Data.getTodayOverallMetrics();
    metricsContainer.innerHTML = `
      <div class="mgr-metric">
        <div class="mgr-metric-label">Applications received today</div>
        <div class="mgr-metric-value">${metrics.receivedToday}</div>
      </div>
      <div class="mgr-metric">
        <div class="mgr-metric-label">Reviewed / processed today</div>
        <div class="mgr-metric-value">${metrics.reviewedToday}</div>
      </div>
      <div class="mgr-metric">
        <div class="mgr-metric-label">Sent onward today</div>
        <div class="mgr-metric-value">${metrics.submittedToCommissionToday}</div>
      </div>
      <div class="mgr-metric">
        <div class="mgr-metric-label">Staff currently logged in</div>
        <div class="mgr-metric-value">${metrics.staffLoggedIn}</div>
      </div>
    `;
  } catch (e) {
    metricsContainer.innerHTML = `<div class="mgr-loading">Couldn't load today's numbers: ${e.message}</div>`;
  }

  const tbody = document.getElementById("mgrStaffTableBody");
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading staff…</td></tr>`;
  try {
    const staff = await Data.getAllStaffSnapshot();
    if (staff.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No active staff yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = staff
      .map(
        (s) => `
        <tr>
          <td class="name">${s.full_name}</td>
          <td class="muted">${s.in_time ? formatTime(s.in_time) : "—"}</td>
          <td class="muted">${s.out_time ? formatTime(s.out_time) : "—"}</td>
          <td>${s.today_total}</td>
        </tr>
      `
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Couldn't load staff: ${e.message}</td></tr>`;
  }
}

async function loadManagerTrends() {
  const tbody = document.getElementById("mgrTrendsTableBody");
  tbody.innerHTML = `<tr><td colspan="3" class="muted">Loading…</td></tr>`;
  try {
    const rows = await Data.getFieldTotalsLast7Days();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">No entries logged in the last 7 days yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td class="name">${r.label}</td>
          <td>${r.last7}</td>
          <td class="muted">${r.today}</td>
        </tr>
      `
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Couldn't load trends: ${e.message}</td></tr>`;
  }
}

let monthlyEmployeeListLoaded = false;

async function loadManagerMonthly() {
  const employeeSelect = document.getElementById("mgrMonthlyEmployeeSelect");
  const fySelect = document.getElementById("mgrMonthlyFySelect");

  if (!monthlyEmployeeListLoaded) {
    try {
      const staff = await Data.getAllStaffSnapshot();
      employeeSelect.innerHTML = staff
        .map((s) => `<option value="${s.id}">${s.full_name}</option>`)
        .join("");

      const fys = await Data.getAvailableFinancialYears();
      fySelect.innerHTML = fys
        .map((fy) => `<option value="${fy.startDate}|${fy.endDate}">${fy.fyLabel}</option>`)
        .join("");

      employeeSelect.onchange = renderManagerMonthlyTable;
      fySelect.onchange = renderManagerMonthlyTable;
      monthlyEmployeeListLoaded = true;
    } catch (e) {
      document.getElementById("mgrMonthlyTableBody").innerHTML =
        `<tr><td class="muted">Couldn't load staff list: ${e.message}</td></tr>`;
      return;
    }
  }

  await renderManagerMonthlyTable();
}

async function renderManagerMonthlyTable() {
  const employeeId = document.getElementById("mgrMonthlyEmployeeSelect").value;
  const fyValue = document.getElementById("mgrMonthlyFySelect").value;
  if (!employeeId || !fyValue) return;
  const [startDate, endDate] = fyValue.split("|");

  const thead = document.getElementById("mgrMonthlyTableHead");
  const tbody = document.getElementById("mgrMonthlyTableBody");
  tbody.innerHTML = `<tr><td class="muted">Loading…</td></tr>`;

  try {
    const { months, fieldLabels } = await Data.getMonthlyKpiForEmployee(employeeId, startDate, endDate);

    if (fieldLabels.length === 0) {
      thead.innerHTML = "";
      tbody.innerHTML = `<tr><td class="muted">No entries logged for this person in this financial year yet.</td></tr>`;
      return;
    }

    thead.innerHTML = `
      <tr>
        <th>Field</th>
        ${months.map((m) => `<th>${m.label}</th>`).join("")}
      </tr>
    `;

    tbody.innerHTML = fieldLabels
      .map(
        (label) => `
        <tr>
          <td class="name">${label}</td>
          ${months.map((m) => `<td>${m.fieldTotals[label] || 0}</td>`).join("")}
        </tr>
      `
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td class="muted">Couldn't load monthly KPI: ${e.message}</td></tr>`;
  }
}

async function loadManagerAlerts() {
  const container = document.getElementById("mgrAlertsContainer");
  container.innerHTML = `<div class="mgr-loading">Checking two-week trends…</div>`;
  try {
    const declining = await Data.getDecliningEmployees(20);
    if (declining.length === 0) {
      container.innerHTML = `<div class="mgr-empty">No employees currently flagged. This compares each person's last 10 working days against the 10 before that — it needs a few weeks of entries before it can say anything meaningful.</div>`;
      return;
    }

    const staff = await Data.getAllStaffSnapshot();
    const nameById = Object.fromEntries(staff.map((s) => [s.id, s.full_name]));

    const since = new Date();
    since.setDate(since.getDate() - 28);
    const sinceStr = since.toISOString().slice(0, 10);

    const cards = await Promise.all(
      declining.map(async (d) => {
        let notesHtml = "";
        try {
          const notes = await Data.getNotesForEmployeeInRange(d.employeeId, sinceStr);
          const relevant = notes.filter((n) => n.note_text || n.additional_work_text);
          if (relevant.length > 0) {
            notesHtml = relevant
              .slice(0, 5)
              .map((n) => {
                const parts = [];
                if (n.additional_work_text) parts.push(`Extra work: ${n.additional_work_text}`);
                if (n.note_text) parts.push(`Note: ${n.note_text}`);
                return `<div class="mgr-alert-note">${n.date} — ${parts.join(" · ")}</div>`;
              })
              .join("");
          }
        } catch (e) {
          console.error("Couldn't load notes for", d.employeeId, e);
        }

        return `
        <div class="mgr-alert-card">
          <div class="mgr-alert-top">
            <div>
              <div class="mgr-alert-title">${nameById[d.employeeId] || "Unknown"} — sustained decline, 2 weeks</div>
              <div class="mgr-alert-body">
                Average daily output down ${d.declinePercent.toFixed(0)}% over the last two weeks compared to the
                two weeks prior (${d.recentAvg.toFixed(1)} vs ${d.priorAvg.toFixed(1)} per day). This is private to
                you, for a conversation, not a score shown anywhere they can see.
              </div>
              ${
                notesHtml
                  ? `<div style="margin-top:8px;"><strong style="font-size:12px;">What they logged in this window:</strong>${notesHtml}</div>`
                  : `<div class="mgr-alert-note">No notes or additional work logged in this window — worth asking directly.</div>`
              }
            </div>
            <span class="mgr-alert-tag">Suggested: 1:1</span>
          </div>
        </div>
      `;
      })
    );

    container.innerHTML = cards.join("");
  } catch (e) {
    container.innerHTML = `<div class="mgr-loading">Couldn't check trends: ${e.message}</div>`;
  }
}
