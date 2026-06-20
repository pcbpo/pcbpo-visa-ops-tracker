// PCBPO Visa Operations Tracker — Auth
// Handles login, first-time signup, logout, and recording the
// daily in-time automatically the moment someone logs in.

const Auth = {
  currentEmployee: null, // { id, full_name, role, is_manager, cycles: [...] }

  async getSession() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session;
  },

  async signUp(email, password, fullName) {
    // Used once per person, the first time they ever open the app.
    // After this, they just log in normally.
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
    });
    if (error) throw error;

    // The employees row itself (full_name, role, cycles) is created by
    // the manager via SQL or the manager-only "Add staff" screen — not
    // here — so a stray sign-up can't grant someone access to data.
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;

    await this.loadEmployeeProfile(data.user.id);
    await this.recordInTimeIfNeeded(data.user.id);
    return data;
  },

  async signOut() {
    if (this.currentEmployee) {
      await this.recordOutTime(this.currentEmployee.id);
    }
    await supabaseClient.auth.signOut();
    this.currentEmployee = null;
  },

  async loadEmployeeProfile(userId) {
    const { data: employee, error: empErr } = await supabaseClient
      .from("employees")
      .select("id, full_name, role, is_manager, active")
      .eq("id", userId)
      .single();

    if (empErr || !employee) {
      throw new Error(
        "No employee record found for this login. Ask your manager to add you to the system."
      );
    }
    if (!employee.active) {
      throw new Error("This account has been deactivated. Contact your manager.");
    }

    const { data: cycles, error: cycErr } = await supabaseClient
      .from("employee_cycles")
      .select("cycle, role_in_cycle")
      .eq("employee_id", userId);

    if (cycErr) throw cycErr;

    this.currentEmployee = { ...employee, cycles: cycles || [] };
    return this.currentEmployee;
  },

  // The moment someone logs in, today's attendance row gets an in_time
  // if it doesn't already have one. If they log in again later the same
  // day (e.g. browser refresh), this does NOT overwrite the original
  // in_time — your actual first login of the day stands.
  async recordInTimeIfNeeded(employeeId) {
    const today = new Date().toISOString().slice(0, 10);

    const { data: existing } = await supabaseClient
      .from("attendance_log")
      .select("id, in_time")
      .eq("employee_id", employeeId)
      .eq("date", today)
      .maybeSingle();

    if (existing && existing.in_time) {
      return existing; // already clocked in today — don't touch it
    }

    if (existing && !existing.in_time) {
      const { data, error } = await supabaseClient
        .from("attendance_log")
        .update({ in_time: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await supabaseClient
      .from("attendance_log")
      .insert({
        employee_id: employeeId,
        date: today,
        in_time: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async recordOutTime(employeeId) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseClient
      .from("attendance_log")
      .update({ out_time: new Date().toISOString() })
      .eq("employee_id", employeeId)
      .eq("date", today);
    if (error) throw error;
  },
};
