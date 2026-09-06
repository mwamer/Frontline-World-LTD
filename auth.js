// Shared Supabase client + auth/session helpers for the admin portal.
const { url, anonKey } = window.SUPABASE_CONFIG;

const isConfigured = url && anonKey && !url.startsWith('YOUR_') && !anonKey.startsWith('YOUR_');

const client = isConfigured
    ? window.supabase.createClient(url, anonKey)
    : null;

function requireConfig() {
    if (!client) {
        document.body.innerHTML = `
            <div class="config-warning">
                <h1>Admin Portal Not Configured</h1>
                <p>Set your Supabase project URL and anon key in <code>admin/config.js</code>, then run
                <code>supabase/schema.sql</code> in your Supabase SQL editor.</p>
                <p>See <code>admin/README.md</code> for full setup steps.</p>
            </div>`;
        throw new Error('Supabase not configured');
    }
    return client;
}

async function getSession() {
    const supabase = requireConfig();
    const { data } = await supabase.auth.getSession();
    return data.session;
}

async function getProfile(userId) {
    const supabase = requireConfig();
    const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}

// Redirects to the login page unless a valid session + staff profile exists.
// Returns { session, profile } when access is granted.
async function requireAuth() {
    const session = await getSession();
    if (!session) {
        window.location.href = 'index.html';
        return null;
    }
    try {
        const profile = await getProfile(session.user.id);
        if (!['admin', 'editor'].includes(profile.role)) {
            await signOut();
            return null;
        }
        return { session, profile };
    } catch {
        window.location.href = 'index.html';
        return null;
    }
}

async function signInWithPassword(email, password) {
    const supabase = requireConfig();
    return supabase.auth.signInWithPassword({ email, password });
}

async function signOut() {
    const supabase = requireConfig();
    await supabase.auth.signOut();
    window.location.href = 'index.html';
}
