function PricingCard() {
  const [billing, setBilling] = React.useState('monthly');
  const monthly = 29;
  const yearly = 290;
  const price = billing === 'monthly' ? monthly : yearly;

  const features = [
    'Unlimited projects',
    'Real-time collaboration',
    'Advanced analytics',
    'Priority support',
  ];

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '24px',
    }}>
      <div style={{
        width: '380px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '24px',
        padding: '40px 32px',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          display: 'inline-block',
          padding: '6px 14px',
          background: 'rgba(99,102,241,0.15)',
          color: '#a5b4fc',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          marginBottom: '20px',
        }}>
          Pro Plan
        </div>

        <h1 style={{
          color: '#f8fafc',
          fontSize: '28px',
          margin: '0 0 8px',
          fontWeight: 700,
        }}>
          Build faster, ship smarter
        </h1>
        <p style={{ color: '#94a3b8', margin: '0 0 28px', fontSize: '15px' }}>
          Everything you need to take your team to the next level.
        </p>

        <div style={{
          display: 'flex',
          gap: '8px',
          padding: '4px',
          background: 'rgba(0,0,0,0.3)',
          borderRadius: '12px',
          marginBottom: '28px',
        }}>
          {['monthly', 'yearly'].map((opt) => (
            <button
              key={opt}
              onClick={() => setBilling(opt)}
              style={{
                flex: 1,
                padding: '10px',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 600,
                textTransform: 'capitalize',
                transition: 'all 0.2s',
                background: billing === opt ? '#6366f1' : 'transparent',
                color: billing === opt ? '#fff' : '#94a3b8',
              }}
            >
              {opt}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: '28px' }}>
          <span style={{ color: '#f8fafc', fontSize: '48px', fontWeight: 800 }}>${price}</span>
          <span style={{ color: '#64748b', fontSize: '16px' }}>
            {billing === 'monthly' ? '/mo' : '/yr'}
          </span>
        </div>

        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 32px' }}>
          {features.map((f) => (
            <li key={f} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              color: '#cbd5e1',
              fontSize: '15px',
              padding: '8px 0',
            }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background: 'rgba(34,197,94,0.15)',
                color: '#4ade80',
                fontSize: '12px',
                fontWeight: 700,
              }}>✓</span>
              {f}
            </li>
          ))}
        </ul>

        <button style={{
          width: '100%',
          padding: '14px',
          border: 'none',
          borderRadius: '12px',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: '#fff',
          fontSize: '15px',
          fontWeight: 700,
          cursor: 'pointer',
          transition: 'transform 0.15s',
        }}
          onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
          onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
        >
          Start free trial
        </button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PricingCard />);
