import { useState, useEffect } from 'react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const BG = '#0A1A3A';
const BG2 = '#0F2550';
const BG3 = '#162E5E';
const ACCENT = '#1E7CF4';
const ACCENT2 = '#00C7B7';
const TEXT = '#E8F0FE';
const TEXT2 = '#8BA8D4';
const SUCCESS = '#00C7B7';
const WARNING = '#F59E0B';

const styles = {
  app: {
    minHeight: '100vh',
    background: BG,
    color: TEXT,
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    padding: '0',
  },
  header: {
    background: BG2,
    borderBottom: `1px solid ${BG3}`,
    padding: '20px 32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: {
    fontSize: '22px',
    fontWeight: '700',
    color: TEXT,
    letterSpacing: '-0.5px',
  },
  logoSpan: { color: ACCENT },
  subtitle: { color: TEXT2, fontSize: '13px', marginTop: '2px' },
  badge: {
    background: ACCENT,
    color: '#fff',
    padding: '4px 12px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: '600',
  },
  main: { padding: '28px 32px' },
  section: { marginBottom: '28px' },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: '600',
    color: TEXT2,
    textTransform: 'uppercase',
    letterSpacing: '0.8px',
    marginBottom: '14px',
  },
  metricsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '16px',
  },
  metricCard: {
    background: BG2,
    border: `1px solid ${BG3}`,
    borderRadius: '12px',
    padding: '20px 24px',
  },
  metricLabel: { fontSize: '12px', color: TEXT2, fontWeight: '500', marginBottom: '8px' },
  metricValue: { fontSize: '32px', fontWeight: '700', color: TEXT, lineHeight: '1' },
  metricSub: { fontSize: '12px', color: TEXT2, marginTop: '6px' },
  accentLine: { width: '3px', borderRadius: '2px', marginRight: '12px', alignSelf: 'stretch' },
  tableContainer: {
    background: BG2,
    border: `1px solid ${BG3}`,
    borderRadius: '12px',
    overflow: 'hidden',
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    background: BG3,
    padding: '12px 16px',
    textAlign: 'left',
    fontSize: '12px',
    fontWeight: '600',
    color: TEXT2,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    borderBottom: `1px solid ${BG3}`,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '12px 16px',
    fontSize: '13px',
    color: TEXT,
    borderBottom: 'rgba(255,255,255,0.05) 1px solid',
    verticalAlign: 'middle',
  },
  naicsPill: {
    display: 'inline-block',
    background: BG3,
    color: ACCENT,
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  opensBadge: {
    background: 'rgba(0,199,183,0.15)',
    color: SUCCESS,
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
  },
  clicksBadge: {
    background: 'rgba(245,158,11,0.15)',
    color: WARNING,
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
  },
  emptyState: {
    padding: '48px',
    textAlign: 'center',
    color: TEXT2,
  },
  refreshBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: TEXT2,
    fontSize: '12px',
    marginBottom: '20px',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: SUCCESS,
  },
  errorBanner: {
    background: 'rgba(239,68,68,0.15)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: '#FCA5A5',
    padding: '12px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    marginBottom: '16px',
  },
};

function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

function MetricCard({ label, value, sub, accentColor }) {
  return (
    <div style={styles.metricCard}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ ...styles.accentLine, background: accentColor || ACCENT }} />
        <div style={{ flex: 1 }}>
          <div style={styles.metricLabel}>{label}</div>
          <div style={{ ...styles.metricValue, color: accentColor || TEXT }}>
            {value === null ? '—' : value}
          </div>
          {sub && <div style={styles.metricSub}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export default function CapGenDashboard() {
  const [metrics, setMetrics] = useState({
    totalContractors: null,
    emailsSent: null,
    openRate: null,
    warmLeads: null,
  });
  const [warmLeads, setWarmLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  async function loadData() {
    setError(null);
    try {
      const [contractorsRes, emailBatchRes, warmLeadsRes] = await Promise.all([
        sbFetch('contractors?select=id'),
        sbFetch('email_batch?select=id,status'),
        sbFetch('warm_leads?select=contractor_id,legal_name,primary_naics,address_city,address_state,contact_email,first_name,last_name,title,last_engagement,open_count,click_count&order=last_engagement.desc&limit=100'),
      ]);

      let totalContractors = 0;
      if (contractorsRes.ok) {
        const rows = await contractorsRes.json();
        totalContractors = rows.length;
      }

      let emailsSent = 0;
      if (emailBatchRes.ok) {
        const batches = await emailBatchRes.json();
        emailsSent = batches.filter(b => b.status === 'sent').length;
      }

      let leads = [];
      if (warmLeadsRes.ok) {
        leads = await warmLeadsRes.json();
      }

      const openCount = leads.filter(l => (l.open_count || 0) > 0).length;
      const openRate = emailsSent > 0
        ? ((openCount / emailsSent) * 100).toFixed(1) + '%'
        : '—';

      setMetrics({ totalContractors, emailsSent, openRate, warmLeads: leads.length });
      setWarmLeads(leads);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Dashboard load error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div>
          <div style={styles.logo}>
            Cap<span style={styles.logoSpan}>Gen</span> Marketing Engine
          </div>
          <div style={styles.subtitle}>Automated federal contractor outreach pipeline</div>
        </div>
        <div style={styles.badge}>Live Dashboard</div>
      </div>

      <div style={styles.main}>
        {error && (
          <div style={styles.errorBanner}>
            Error loading data: {error}
          </div>
        )}

        <div style={styles.refreshBar}>
          <div style={styles.dot} />
          <span>
            {lastRefresh
              ? `Last updated ${lastRefresh.toLocaleTimeString()} · Auto-refreshes every 30s`
              : 'Loading...'}
          </span>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Pipeline Overview</div>
          <div style={styles.metricsGrid}>
            <MetricCard
              label="Total Contractors"
              value={loading ? '...' : (metrics.totalContractors || 0).toLocaleString()}
              sub="SAM.gov registered"
              accentColor={ACCENT}
            />
            <MetricCard
              label="Emails Sent"
              value={loading ? '...' : (metrics.emailsSent || 0).toLocaleString()}
              sub="Via Resend"
              accentColor={ACCENT2}
            />
            <MetricCard
              label="Open Rate"
              value={loading ? '...' : metrics.openRate}
              sub="Unique opens"
              accentColor={SUCCESS}
            />
            <MetricCard
              label="Warm Leads"
              value={loading ? '...' : metrics.warmLeads}
              sub="Opened or clicked"
              accentColor={WARNING}
            />
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Warm Leads ({warmLeads.length})
          </div>
          <div style={styles.tableContainer}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Company</th>
                  <th style={styles.th}>Contact</th>
                  <th style={styles.th}>Email</th>
                  <th style={styles.th}>NAICS</th>
                  <th style={styles.th}>City / State</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Opens</th>
                  <th style={{ ...styles.th, textAlign: 'center' }}>Clicks</th>
                  <th style={styles.th}>Last Engagement</th>
                </tr>
              </thead>
              <tbody>
                {warmLeads.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={styles.td}>
                      <div style={styles.emptyState}>
                        {loading
                          ? 'Loading warm leads...'
                          : 'No warm leads yet — send some emails to get started!'}
                      </div>
                    </td>
                  </tr>
                ) : (
                  warmLeads.map((lead, i) => (
                    <tr
                      key={`${lead.contractor_id}-${lead.contact_email}-${i}`}
                      style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}
                    >
                      <td style={{ ...styles.td, fontWeight: '600', maxWidth: '200px' }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {lead.legal_name || '—'}
                        </div>
                      </td>
                      <td style={styles.td}>
                        <div>
                          {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '—'}
                        </div>
                        {lead.title && (
                          <div style={{ fontSize: '11px', color: TEXT2, marginTop: '2px' }}>
                            {lead.title}
                          </div>
                        )}
                      </td>
                      <td style={{ ...styles.td, fontSize: '12px', color: TEXT2 }}>
                        {lead.contact_email || '—'}
                      </td>
                      <td style={styles.td}>
                        {lead.primary_naics ? (
                          <span style={styles.naicsPill}>{lead.primary_naics}</span>
                        ) : '—'}
                      </td>
                      <td style={{ ...styles.td, color: TEXT2 }}>
                        {[lead.address_city, lead.address_state].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <span style={styles.opensBadge}>{lead.open_count || 0}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <span style={styles.clicksBadge}>{lead.click_count || 0}</span>
                      </td>
                      <td style={{ ...styles.td, fontSize: '12px', color: TEXT2, whiteSpace: 'nowrap' }}>
                        {formatDate(lead.last_engagement)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
