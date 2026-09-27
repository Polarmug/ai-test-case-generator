import { useState } from 'react';
import axios from 'axios';
import './App.css';

type TestType = 'Happy Path' | 'Negative' | 'Edge Case' | 'Other';

interface TestCase {
  testCaseId: string;
  scenario: string;
  type: TestType;
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
  storyId: string;
}

interface Coverage {
  criterion: string;
  testCaseIds: string[];
}

interface GenerateResponse {
  testCases: TestCase[];
  coverage: Coverage[];
  provider: string;
  model: string;
  fallback: boolean;
  notice?: string;
}

// In dev the backend runs separately on :3001; in production it serves this page, so use the same origin.
const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

const TYPES: TestType[] = ['Happy Path', 'Negative', 'Edge Case'];

const PROVIDER_LABELS: Record<string, string> = {
  bob: 'IBM Bob',
  watsonx: 'IBM watsonx.ai',
  fallback: 'Saved example'
};

const EXAMPLE_STORY = `Story ID: 001
As a user, I want to log in so that I can access my account.
Acceptance criteria:
- valid credentials grant access
- wrong password is rejected
- account locks after 5 failed attempts`;

const slug = (text: string) => text.toLowerCase().replace(/\s+/g, '-');

function App() {
  const [userStory, setUserStory] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<TestType | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const testCases = result?.testCases ?? [];
  const coverage = result?.coverage ?? [];
  const visible = filter ? testCases.filter(tc => tc.type === filter) : testCases;
  const coveredCount = coverage.filter(c => c.testCaseIds.length > 0).length;
  const countOf = (type: TestType) => testCases.filter(tc => tc.type === type).length;

  const generate = async () => {
    if (!userStory.trim() || loading) return;
    setLoading(true);
    setError('');
    setFilter(null);
    setHighlighted(null);
    const started = performance.now();
    try {
      const res = await axios.post<GenerateResponse>(`${API_URL}/api/generate`, { userStory });
      setResult(res.data);
      setElapsed((performance.now() - started) / 1000);
    } catch (err) {
      const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      setError(message ?? 'Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const jumpTo = (id: string) => {
    setFilter(null);
    setHighlighted(id);
    setTimeout(() => {
      document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const exportCSV = () => {
    const headers = ['Test Case ID', 'Scenario', 'Type', 'Preconditions', 'Steps', 'Test Data', 'Expected Result', 'Story ID'];
    const rows = testCases.map(tc => [
      tc.testCaseId, tc.scenario, tc.type, tc.preconditions,
      tc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), tc.testData, tc.expectedResult, tc.storyId
    ]);
    const escape = (c: unknown) => `"${String(c ?? '').replace(/"/g, '""')}"`;
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
    // BOM so Excel opens the file as UTF-8
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const storyId = testCases[0]?.storyId;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = storyId ? `test-cases-${storyId}.csv` : 'test-cases.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>AI Test-Case Generator</h1>
          <p className="tagline">Turn a user story into ready-to-run test cases in seconds.</p>
        </div>
        {result && (
          <span className="provider">
            Powered by {PROVIDER_LABELS[result.provider] ?? result.provider}
            {result.model && <span className="muted"> · {result.model}</span>}
          </span>
        )}
      </header>

      <section className="card">
        <div className="card-head">
          <label htmlFor="story">User story &amp; acceptance criteria</label>
          <button className="link-btn" onClick={() => setUserStory(EXAMPLE_STORY)} disabled={loading}>
            Load example
          </button>
        </div>
        <textarea
          id="story"
          value={userStory}
          onChange={e => setUserStory(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
          }}
          placeholder="Paste a user story with its acceptance criteria..."
          rows={8}
        />
        <div className="actions">
          <button className="primary" onClick={generate} disabled={loading || !userStory.trim()}>
            {loading ? <><span className="spinner" /> Generating…</> : 'Generate test cases'}
          </button>
          <span className="hint">Ctrl + Enter</span>
          {testCases.length > 0 && (
            <button className="secondary" onClick={exportCSV}>Export CSV</button>
          )}
        </div>
      </section>

      {error && <div className="banner banner-error">{error}</div>}
      {result?.notice && <div className="banner banner-warn">{result.notice}</div>}

      {testCases.length > 0 && (
        <>
          <section className="summary">
            <button className={`stat ${filter === null ? 'active' : ''}`} onClick={() => setFilter(null)}>
              <strong>{testCases.length}</strong> total
            </button>
            {TYPES.map(type => (
              <button
                key={type}
                className={`stat stat-${slug(type)} ${filter === type ? 'active' : ''}`}
                onClick={() => setFilter(filter === type ? null : type)}
              >
                <strong>{countOf(type)}</strong> {type}
              </button>
            ))}
            {!result?.fallback && <span className="elapsed">Generated in {elapsed.toFixed(1)}s</span>}
          </section>

          {coverage.length > 0 && (
            <section className="card">
              <h2>
                Acceptance criteria coverage
                <span className={`coverage-score ${coveredCount === coverage.length ? 'full' : 'partial'}`}>
                  {coveredCount}/{coverage.length} covered
                </span>
              </h2>
              <ul className="coverage">
                {coverage.map((c, i) => (
                  <li key={i} className={c.testCaseIds.length ? 'covered' : 'uncovered'}>
                    <span className="check">{c.testCaseIds.length ? '✓' : '!'}</span>
                    <span className="criterion">{c.criterion}</span>
                    <span className="ids">
                      {c.testCaseIds.length
                        ? c.testCaseIds.map(id => (
                            <button key={id} className="chip" onClick={() => jumpTo(id)}>{id}</button>
                          ))
                        : <em>Not covered</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card table-card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Scenario</th>
                    <th>Type</th>
                    <th>Steps</th>
                    <th>Test data</th>
                    <th>Expected result</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((tc, idx) => (
                    <tr
                      key={`${tc.testCaseId}-${idx}`}
                      id={`row-${tc.testCaseId}`}
                      className={highlighted === tc.testCaseId ? 'highlight' : ''}
                    >
                      <td className="mono">{tc.testCaseId}</td>
                      <td>
                        <div className="scenario">{tc.scenario}</div>
                        {tc.preconditions && (
                          <div className="sub"><span>Preconditions:</span> {tc.preconditions}</div>
                        )}
                      </td>
                      <td><span className={`badge badge-${slug(tc.type)}`}>{tc.type}</span></td>
                      <td>
                        <ol className="steps">
                          {tc.steps.map((s, i) => <li key={i}>{s}</li>)}
                        </ol>
                      </td>
                      <td className="test-data">{tc.testData || '—'}</td>
                      <td>{tc.expectedResult}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default App;
