// PCBPO Visa Operations Tracker — Data access layer
// All reads/writes to daily_entries, field_definitions, etc. go
// through here so the UI code stays simple.

const Data = {
  // PCBPO's financial year runs 1 April – 31 March.
  // Given any date, returns { fyLabel, startDate, endDate } for the
  // financial year that date falls within.
  getFinancialYearFor(date = new Date()) {
    const year = date.getFullYear();
    const isAfterApril = date.getMonth() >= 3; // month 3 = April (0-indexed)
    const startYear = isAfterApril ? year : year - 1;
    const endYear = startYear + 1;
    return {
      fyLabel: `FY ${startYear}–${endYear}`,
      startDate: `${startYear}-04-01`,
      endDate: `${endYear}-03-31`,
    };
  },

  // Returns the list of available financial years that have any data,
  // for a dropdown — plus the current one even if it has no data yet.
  async getAvailableFinancialYears() {
    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("date")
      .order("date", { ascending: true })
      .limit(1);
    if (error) throw error;

    const years = new Set();
    const current = this.getFinancialYearFor(new Date());
    years.add(current.fyLabel);

    if (data && data.length > 0) {
      const earliest = new Date(data[0].date);
      const earliestFY = this.getFinancialYearFor(earliest);
      // walk forward from earliest FY to current FY
      let cursor = new Date(earliestFY.startDate);
      const currentStart = new Date(current.startDate);
      while (cursor <= currentStart) {
        years.add(this.getFinancialYearFor(cursor).fyLabel);
        cursor.setFullYear(cursor.getFullYear() + 1);
      }
    }
    return [...years].sort().reverse().map((label) => {
      const fy = this._fyFromLabel(label);
      return fy;
    });
  },

  _fyFromLabel(label) {
    const startYear = parseInt(label.match(/\d{4}/)[0], 10);
    return {
      fyLabel: label,
      startDate: `${startYear}-04-01`,
      endDate: `${startYear + 1}-03-31`,
    };
  },

  // Monthly KPI breakdown for ONE employee, across a financial year.
  // Returns an array of { month: 'Apr 2026', fieldTotals: { label: total } }
  // plus a flat field list so the UI can build a table.
  async getMonthlyKpiForEmployee(employeeId, startDate, endDate) {
    const { data: entries, error } = await supabaseClient
      .from("daily_entries")
      .select("date, amount, entry_type, field_definitions(field_label, entry_mode)")
      .eq("employee_id", employeeId)
      .gte("date", startDate)
      .lte("date", endDate)
      .in("entry_type", ["individual_increment", "shared_batch_entry", "shared_batch_correction"]);
    if (error) throw error;

    const byMonth = {}; // 'YYYY-MM' -> { label: total }
    const allFieldLabels = new Set();

    for (const e of entries) {
      const fd = e.field_definitions;
      if (!fd) continue;
      const monthKey = e.date.slice(0, 7); // YYYY-MM
      byMonth[monthKey] = byMonth[monthKey] || {};
      byMonth[monthKey][fd.field_label] = (byMonth[monthKey][fd.field_label] || 0) + e.amount;
      allFieldLabels.add(fd.field_label);
    }

    // Build ordered list of months across the FY, April first, so empty
    // months still show as zero rather than being silently skipped.
    const months = [];
    let cursor = new Date(startDate);
    const end = new Date(endDate);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 7);
      months.push({
        key,
        label: cursor.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
        fieldTotals: byMonth[key] || {},
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return { months, fieldLabels: [...allFieldLabels].sort() };
  },

  async getClientDepartments() {
    const { data, error } = await supabaseClient
      .from("client_departments")
      .select("id, name")
      .eq("active", true)
      .order("name");
    if (error) throw error;
    return data;
  },

  // Returns the union of fields across every cycle this employee is
  // assigned to, in sort order. This is what makes Vinvinu see both
  // passport_collection AND payment_settlement fields.
  async getFieldsForEmployee(employee) {
    if (!employee.cycles || employee.cycles.length === 0) return [];

    const cycleRolePairs = employee.cycles.map((c) => c.role_in_cycle);

    const { data, error } = await supabaseClient
      .from("field_definitions")
      .select("*")
      .eq("active", true)
      .order("sort_order");
    if (error) throw error;

    // applies_to_role is a postgres array column; filter client-side
    // since it's a small table and keeps the query simple.
    return data.filter((f) =>
      f.applies_to_role.some((r) => cycleRolePairs.includes(r))
    );
  },

  // Sum of an employee's entries for one field, today, accounting for
  // increments AND the most recent manual_set (a manual set replaces
  // everything logged before it, not adds to it).
  async getTodayTotals(employeeId) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, amount, entry_type, created_at")
      .eq("employee_id", employeeId)
      .eq("date", today)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const totals = {};
    for (const row of data) {
      if (row.entry_type === "individual_manual_set") {
        totals[row.field_id] = row.amount; // replaces, doesn't add
      } else if (row.entry_type === "individual_increment") {
        totals[row.field_id] = (totals[row.field_id] || 0) + row.amount;
      }
    }
    return totals;
  },

  // Shared-batch fields: returns today's single entry per field (if any),
  // visible to the whole team regardless of who's logged in.
  async getTodaySharedEntries() {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, amount, entry_type, created_at, employee_id, employees(full_name)")
      .eq("date", today)
      .in("entry_type", ["shared_batch_entry", "shared_batch_correction"])
      .order("created_at", { ascending: true });
    if (error) throw error;

    // last entry per field wins (corrections supersede the original)
    const latest = {};
    for (const row of data) {
      latest[row.field_id] = row;
    }
    return latest;
  },

  async logIncrement(employeeId, fieldId, clientDeptId, amount) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient.from("daily_entries").insert({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: clientDeptId,
      date: today,
      amount,
      entry_type: "individual_increment",
    });
    if (error) throw error;
  },

  async setManualValue(employeeId, fieldId, clientDeptId, amount) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient.from("daily_entries").insert({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: clientDeptId,
      date: today,
      amount,
      entry_type: "individual_manual_set",
    });
    if (error) throw error;
  },

  async logSharedBatch(employeeId, fieldId, clientDeptId, amount) {
    const today = new Date().toISOString().slice(0, 10);
    // Guard against a race where two people submit at nearly the same
    // moment: re-check immediately before insert. The RLS layer doesn't
    // enforce uniqueness here (kept simple for v1), so this check is
    // best-effort — a manager can always issue a correction afterward.
    const existing = await this.getTodaySharedEntries();
    if (existing[fieldId]) {
      throw new Error(
        `Already logged today by ${existing[fieldId].employees?.full_name || "someone"}. Use "Request correction" instead.`
      );
    }
    const { error } = await supabaseClient.from("daily_entries").insert({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: clientDeptId,
      date: today,
      amount,
      entry_type: "shared_batch_entry",
    });
    if (error) throw error;
  },

  async correctSharedBatch(employeeId, fieldId, clientDeptId, newAmount, originalEntryId) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient.from("daily_entries").insert({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: clientDeptId,
      date: today,
      amount: newAmount,
      entry_type: "shared_batch_correction",
      corrects_entry_id: originalEntryId,
    });
    if (error) throw error;
  },

  async saveNote(employeeId, noteText, additionalWorkText) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient.from("daily_note").upsert(
      {
        employee_id: employeeId,
        date: today,
        note_text: noteText,
        additional_work_text: additionalWorkText,
      },
      { onConflict: "employee_id,date" }
    );
    if (error) throw error;
  },

  // Used by the manager's PPIP alert view, to show what someone logged
  // as extra/unassigned work over the flagged window — context for why
  // their tracked-field numbers might look low without it being a
  // genuine performance issue.
  async getNotesForEmployeeInRange(employeeId, sinceDate) {
    const { data, error } = await supabaseClient
      .from("daily_note")
      .select("date, note_text, additional_work_text")
      .eq("employee_id", employeeId)
      .gte("date", sinceDate)
      .order("date", { ascending: false });
    if (error) throw error;
    return data;
  },

  async getTodayAttendance(employeeId) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient
      .from("attendance_log")
      .select("in_time, out_time")
      .eq("employee_id", employeeId)
      .eq("date", today)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // ---------- Manager-facing aggregates ----------

  // Today's headline numbers across the whole team, for the 4 metric
  // tiles. "Received" / "Reviewed" / "Sent to commission" are pattern-
  // matched by field_key since field sets differ per cycle — this
  // looks for the most universally meaningful ones across cycles.
  async getTodayOverallMetrics() {
    const today = new Date().toISOString().slice(0, 10);

    const { data: entries, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, amount, entry_type, field_definitions(field_key, field_label)")
      .eq("date", today)
      .in("entry_type", ["individual_increment", "individual_manual_set", "shared_batch_entry", "shared_batch_correction"]);
    if (error) throw error;

    const { data: attendance, error: attErr } = await supabaseClient
      .from("attendance_log")
      .select("employee_id, in_time, out_time")
      .eq("date", today);
    if (attErr) throw attErr;

    const { count: totalStaff } = await supabaseClient
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("is_manager", false);

    const loggedInCount = attendance.filter((a) => a.in_time && !a.out_time).length;

    // Sum totals per field_key across everyone, today.
    const byKey = {};
    for (const e of entries) {
      const key = e.field_definitions?.field_key;
      if (!key) continue;
      if (e.entry_type === "individual_manual_set") {
        byKey[key] = Math.max(byKey[key] || 0, e.amount); // approximation for cross-employee summary
      } else {
        byKey[key] = (byKey[key] || 0) + e.amount;
      }
    }

    const sumMatching = (substrings) =>
      Object.entries(byKey)
        .filter(([k]) => substrings.some((s) => k.includes(s)))
        .reduce((sum, [, v]) => sum + v, 0);

    return {
      receivedToday: sumMatching(["received"]),
      reviewedToday: sumMatching(["reviewed", "compiled", "attended", "collected"]),
      submittedToCommissionToday: sumMatching(["submitted_to_commission", "wo_sent", "submitted_to_immigration"]),
      staffLoggedIn: `${loggedInCount} / ${totalStaff || 0}`,
    };
  },

  // Per-field totals over the last 7 calendar days, plus today's value,
  // for the Trends table. Individual fields only (shared_batch fields
  // are already single daily facts, less useful to trend this way).
  async getFieldTotalsLast7Days() {
    const since = new Date();
    since.setDate(since.getDate() - 6);
    const sinceStr = since.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const { data: entries, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, amount, date, entry_type, field_definitions(field_key, field_label, entry_mode)")
      .gte("date", sinceStr)
      .in("entry_type", ["individual_increment", "shared_batch_entry", "shared_batch_correction"]);
    if (error) throw error;

    const totals = {};
    for (const e of entries) {
      const fd = e.field_definitions;
      if (!fd) continue;
      const label = fd.field_label;
      totals[label] = totals[label] || { last7: 0, today: 0 };
      totals[label].last7 += e.amount;
      if (e.date === today) totals[label].today += e.amount;
    }

    return Object.entries(totals)
      .map(([label, v]) => ({ label, last7: v.last7, today: v.today }))
      .sort((a, b) => b.last7 - a.last7);
  },

  async getAllStaffSnapshot() {
    const today = new Date().toISOString().slice(0, 10);
    const { data: employees, error: empErr } = await supabaseClient
      .from("employees")
      .select("id, full_name, is_manager, active")
      .eq("active", true)
      .eq("is_manager", false);
    if (empErr) throw empErr;

    const { data: attendance, error: attErr } = await supabaseClient
      .from("attendance_log")
      .select("employee_id, in_time, out_time")
      .eq("date", today);
    if (attErr) throw attErr;

    const { data: entries, error: entErr } = await supabaseClient
      .from("daily_entries")
      .select("employee_id, amount, entry_type")
      .eq("date", today);
    if (entErr) throw entErr;

    const attByEmp = Object.fromEntries(attendance.map((a) => [a.employee_id, a]));
    const totalsByEmp = {};
    for (const e of entries) {
      if (e.entry_type === "individual_increment") {
        totalsByEmp[e.employee_id] = (totalsByEmp[e.employee_id] || 0) + e.amount;
      }
    }

    return employees.map((emp) => ({
      ...emp,
      in_time: attByEmp[emp.id]?.in_time || null,
      out_time: attByEmp[emp.id]?.out_time || null,
      today_total: totalsByEmp[emp.id] || 0,
    }));
  },

  // Two-week trend check used for the PPIP alert. Returns employees
  // whose average daily output over the last 10 working days is down
  // significantly vs the 10 working days before that.
  async getDecliningEmployees(thresholdPercent = 20) {
    const since = new Date();
    since.setDate(since.getDate() - 28); // ~4 weeks of calendar days to cover 20 working days
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: entries, error } = await supabaseClient
      .from("daily_entries")
      .select("employee_id, date, amount, entry_type")
      .eq("entry_type", "individual_increment")
      .gte("date", sinceStr);
    if (error) throw error;

    const byEmpDate = {};
    for (const e of entries) {
      byEmpDate[e.employee_id] = byEmpDate[e.employee_id] || {};
      byEmpDate[e.employee_id][e.date] =
        (byEmpDate[e.employee_id][e.date] || 0) + e.amount;
    }

    const allDates = [...new Set(entries.map((e) => e.date))].sort();
    const recentDates = allDates.slice(-10);
    const priorDates = allDates.slice(-20, -10);

    const results = [];
    for (const [employeeId, dateMap] of Object.entries(byEmpDate)) {
      const recentAvg =
        recentDates.reduce((s, d) => s + (dateMap[d] || 0), 0) / (recentDates.length || 1);
      const priorAvg =
        priorDates.reduce((s, d) => s + (dateMap[d] || 0), 0) / (priorDates.length || 1);

      if (priorAvg > 0) {
        const declinePercent = ((priorAvg - recentAvg) / priorAvg) * 100;
        if (declinePercent >= thresholdPercent) {
          results.push({ employeeId, recentAvg, priorAvg, declinePercent });
        }
      }
    }
    return results;
  },
};
