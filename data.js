// PCBPO Visa Operations Tracker — Data access layer
// All reads/writes to daily_entries, field_definitions, etc. go
// through here so the UI code stays simple.

const Data = {
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

  async saveNote(employeeId, noteText) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient.from("daily_note").upsert(
      { employee_id: employeeId, date: today, note_text: noteText },
      { onConflict: "employee_id,date" }
    );
    if (error) throw error;
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
