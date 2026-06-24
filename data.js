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

  // Returns ALL fields for a given cycle regardless of role — used when
  // a staff member borrows a cycle for the day without being formally
  // assigned to any role within it.
  async getFieldsForCycle(cycle) {
    const { data, error } = await supabaseClient
      .from("field_definitions")
      .select("*")
      .eq("active", true)
      .eq("cycle", cycle)
      .order("sort_order");
    if (error) throw error;
    return data;
  },

  // Running backlog per person: for each "received" field that has a
  // backlog_pair_field_key set, computes (all-time received total) −
  // (all-time reviewed/processed total). This is NOT reset daily — it's
  // the actual outstanding pile, however many days it took to build up.
  // Floored at 0 (more reviewed than received overall just means caught
  // up, not a negative backlog).
  // `employeeFields` should be the array already returned by
  // getFieldsForEmployee for this person (avoids re-fetching).
  async getBacklogForEmployee(employeeId, employeeFields) {
    const pairedFields = employeeFields.filter((f) => f.backlog_pair_field_key);
    if (pairedFields.length === 0) return [];

    const fieldKeyToId = {};
    employeeFields.forEach((f) => {
      fieldKeyToId[f.field_key] = f.id;
    });

    const relevantFieldIds = [];
    pairedFields.forEach((f) => {
      relevantFieldIds.push(f.id);
      const pairedId = fieldKeyToId[f.backlog_pair_field_key];
      if (pairedId) relevantFieldIds.push(pairedId);
    });

    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, client_dept_id, amount, entry_type, client_departments(name)")
      .eq("employee_id", employeeId)
      .in("field_id", relevantFieldIds)
      .in("entry_type", ["individual_increment", "individual_manual_set"]);
    if (error) throw error;

    // Bucket by (field_id, department) instead of just field_id, so
    // backlog can be broken out per client department, not just an
    // overall number. Same manual_set simplification as before — see
    // note below — applies per department bucket too.
    const totalsByFieldAndDept = {}; // field_id -> dept_key -> amount
    const deptNameByKey = {};
    for (const row of data) {
      const deptKey = row.client_dept_id || "__none__";
      deptNameByKey[deptKey] = row.client_departments?.name || "No department";
      totalsByFieldAndDept[row.field_id] = totalsByFieldAndDept[row.field_id] || {};
      totalsByFieldAndDept[row.field_id][deptKey] =
        (totalsByFieldAndDept[row.field_id][deptKey] || 0) + row.amount;
    }

    return pairedFields.map((f) => {
      const pairedId = fieldKeyToId[f.backlog_pair_field_key];
      const receivedByDept = totalsByFieldAndDept[f.id] || {};
      const reviewedByDept = pairedId ? totalsByFieldAndDept[pairedId] || {} : {};

      const allDeptKeys = new Set([...Object.keys(receivedByDept), ...Object.keys(reviewedByDept)]);
      const byDepartment = [...allDeptKeys]
        .map((deptKey) => {
          const received = receivedByDept[deptKey] || 0;
          const reviewed = reviewedByDept[deptKey] || 0;
          return {
            deptName: deptNameByKey[deptKey] || "No department",
            received,
            reviewed,
            backlog: Math.max(0, received - reviewed),
          };
        })
        .filter((d) => d.backlog > 0)
        .sort((a, b) => b.backlog - a.backlog);

      const receivedTotal = Object.values(receivedByDept).reduce((s, v) => s + v, 0);
      const reviewedTotal = Object.values(reviewedByDept).reduce((s, v) => s + v, 0);

      return {
        receivedFieldLabel: f.field_label,
        receivedTotal,
        reviewedTotal,
        backlog: Math.max(0, receivedTotal - reviewedTotal),
        byDepartment, // already filtered to backlog > 0, sorted highest first
      };
    });
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

  // Same data, but broken down per client department, for fields where
  // a single day's work spans multiple departments (e.g. a Port CALM
  // batch covering several clients at once). Returns:
  // { [field_id]: { [client_dept_id]: total, ... } }
  // A manual-set for a given (field, department) pair replaces just
  // that department's number, not the whole field's total across
  // departments — each department is tracked independently.
  async getTodayTotalsByDepartment(employeeId) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("field_id, client_dept_id, amount, entry_type, created_at")
      .eq("employee_id", employeeId)
      .eq("date", today)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const totals = {}; // field_id -> dept_id (or '__none__') -> amount
    for (const row of data) {
      const deptKey = row.client_dept_id || "__none__";
      totals[row.field_id] = totals[row.field_id] || {};
      if (row.entry_type === "individual_manual_set") {
        totals[row.field_id][deptKey] = row.amount;
      } else if (row.entry_type === "individual_increment") {
        totals[row.field_id][deptKey] = (totals[row.field_id][deptKey] || 0) + row.amount;
      }
    }
    return totals;
  },

  // Shared-batch fields: returns today's entries per field, grouped by
  // department, since one logging event (e.g. one commission letter)
  // can cover several departments at once. Returns:
  // { [field_id]: { rows: [{id, client_dept_id, amount}, ...], total, loggedBy, loggedAt } }
  // If a field has any correction rows, only the correction rows are
  // shown (as the new full breakdown) — corrections replace, not merge.
  async getTodaySharedEntries() {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("id, field_id, client_dept_id, amount, entry_type, created_at, employee_id, employees(full_name)")
      .eq("date", today)
      .in("entry_type", ["shared_batch_entry", "shared_batch_correction"])
      .order("created_at", { ascending: true });
    if (error) throw error;

    const byField = {};
    for (const row of data) {
      byField[row.field_id] = byField[row.field_id] || [];
      byField[row.field_id].push(row);
    }

    const result = {};
    for (const [fieldId, rows] of Object.entries(byField)) {
      const corrections = rows.filter((r) => r.entry_type === "shared_batch_correction");
      const activeRows = corrections.length > 0 ? corrections : rows;
      const total = activeRows.reduce((s, r) => s + r.amount, 0);
      const last = activeRows[activeRows.length - 1];
      result[fieldId] = {
        rows: activeRows,
        total,
        loggedBy: last.employees?.full_name || "—",
        loggedAt: last.created_at,
      };
    }
    return result;
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

  // entries: array of { clientDeptId, amount } — one logging action that
  // can cover several departments at once (e.g. one commission letter
  // listing several clients). Inserted together; blocked if the field
  // already has a batch logged today.
  async logSharedBatch(employeeId, fieldId, entries) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await this.getTodaySharedEntries();
    if (existing[fieldId]) {
      throw new Error(
        `Already logged today by ${existing[fieldId].loggedBy}. Use "Request correction" instead.`
      );
    }
    const rows = entries.map((e) => ({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: e.clientDeptId,
      date: today,
      amount: e.amount,
      entry_type: "shared_batch_entry",
    }));
    const { error } = await supabaseClient.from("daily_entries").insert(rows);
    if (error) throw error;
  },

  // Corrections replace the field's WHOLE breakdown for today, same
  // shape as the original entry (one or more departments at once).
  async correctSharedBatch(employeeId, fieldId, entries, originalEntryId) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = entries.map((e) => ({
      employee_id: employeeId,
      field_id: fieldId,
      client_dept_id: e.clientDeptId,
      date: today,
      amount: e.amount,
      entry_type: "shared_batch_correction",
      corrects_entry_id: originalEntryId,
    }));
    const { error } = await supabaseClient.from("daily_entries").insert(rows);
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

  // Total outstanding backlog (all-time received minus reviewed, summed
  // across every paired field and every department) for EVERY active
  // employee in one pass — used for the manager's staff snapshot column.
  // Returns { [employee_id]: totalBacklog }. Employees with no paired
  // fields, or fully caught up, simply won't appear (treated as 0).
  async getBacklogTotalsForAllStaff() {
    // Step 1: which fields are part of a backlog pair at all.
    const { data: pairedFields, error: pfErr } = await supabaseClient
      .from("field_definitions")
      .select("id, field_key, backlog_pair_field_key")
      .not("backlog_pair_field_key", "is", null);
    if (pfErr) throw pfErr;
    if (pairedFields.length === 0) return {};

    const fieldKeyToId = {};
    const { data: allFields, error: afErr } = await supabaseClient
      .from("field_definitions")
      .select("id, field_key");
    if (afErr) throw afErr;
    allFields.forEach((f) => (fieldKeyToId[f.field_key] = f.id));

    const relevantFieldIds = new Set();
    pairedFields.forEach((f) => {
      relevantFieldIds.add(f.id);
      const pairedId = fieldKeyToId[f.backlog_pair_field_key];
      if (pairedId) relevantFieldIds.add(pairedId);
    });

    // Step 2: pull every relevant entry for every employee in one query.
    const { data: entries, error: enErr } = await supabaseClient
      .from("daily_entries")
      .select("employee_id, field_id, amount, entry_type")
      .in("field_id", [...relevantFieldIds])
      .in("entry_type", ["individual_increment", "individual_manual_set"]);
    if (enErr) throw enErr;

    // totals[employee_id][field_id] = amount
    const totals = {};
    for (const row of entries) {
      totals[row.employee_id] = totals[row.employee_id] || {};
      totals[row.employee_id][row.field_id] =
        (totals[row.employee_id][row.field_id] || 0) + row.amount;
    }

    // Step 3: for each employee, sum backlog across all their paired fields.
    const result = {};
    for (const employeeId of Object.keys(totals)) {
      let backlogSum = 0;
      for (const pf of pairedFields) {
        const receivedTotal = totals[employeeId][pf.id] || 0;
        const pairedId = fieldKeyToId[pf.backlog_pair_field_key];
        const reviewedTotal = pairedId ? totals[employeeId][pairedId] || 0 : 0;
        backlogSum += Math.max(0, receivedTotal - reviewedTotal);
      }
      result[employeeId] = backlogSum;
    }
    return result;
  },

  // Two-week trend check used for the PPIP alert. Returns employees
  // whose average daily output over the last 10 working days is down
  // significantly vs the 10 working days before that.
  // Average daily total (across ALL individual fields combined) for an
  // employee over their last N working days, EXCLUDING today — used to
  // show "up/down X% vs your recent average" on the logout summary.
  async getRecentDailyAverage(employeeId, workingDays = 5) {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date();
    since.setDate(since.getDate() - (workingDays * 2)); // generous buffer for weekends/gaps
    const sinceStr = since.toISOString().slice(0, 10);

    const { data, error } = await supabaseClient
      .from("daily_entries")
      .select("date, amount, entry_type")
      .eq("employee_id", employeeId)
      .eq("entry_type", "individual_increment")
      .gte("date", sinceStr)
      .lt("date", today); // excludes today on purpose
    if (error) throw error;

    const byDate = {};
    for (const row of data) {
      byDate[row.date] = (byDate[row.date] || 0) + row.amount;
    }
    const recentDates = Object.keys(byDate).sort().slice(-workingDays);
    if (recentDates.length === 0) return null; // not enough history yet

    const avg = recentDates.reduce((s, d) => s + byDate[d], 0) / recentDates.length;
    return { average: avg, daysUsed: recentDates.length };
  },

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
