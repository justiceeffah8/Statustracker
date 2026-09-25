import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, EmailAuthProvider, getAuth, linkWithCredential, onAuthStateChanged, sendPasswordResetEmail, signInWithCustomToken, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, addDoc, deleteDoc, updateDoc, increment, runTransaction } from 'firebase/firestore';
import { BookOpen, Users, Upload, Plus, ChevronRight, CheckCircle2, Search, ArrowLeft, Loader2, LogOut, Trash2, FileText, Sparkles, Send, Copy, ChevronDown } from 'lucide-react';

declare global {
  interface Window {
    pdfjsLib: any;
  }
}

// --- Environment Variables & API Setup ---
const runtime = globalThis as typeof globalThis & {
  __app_id?: string;
  __firebase_config?: string | Record<string, string>;
  __initial_auth_token?: string;
};

const parseFirebaseConfig = (): Record<string, string> => {
  const raw = runtime.__firebase_config ?? import.meta.env.VITE_FIREBASE_CONFIG;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    console.error('VITE_FIREBASE_CONFIG must be valid JSON.');
    return {};
  }
};

const appId = runtime.__app_id ?? import.meta.env.VITE_APP_ID ?? 'status-tracker-local';
const firebaseConfig = parseFirebaseConfig();
const initialAuthToken = runtime.__initial_auth_token ?? import.meta.env.VITE_INITIAL_AUTH_TOKEN ?? null;
const isRealConfigValue = (value?: string) => Boolean(
  value &&
  !/^(your[-_]|replace[-_]|example$)/i.test(value) &&
  !value.includes('your-project')
);
const firebaseReady = isRealConfigValue(firebaseConfig.apiKey) && isRealConfigValue(firebaseConfig.projectId);
const hostedApiOrigin = String(import.meta.env.VITE_API_BASE_URL || (
  ['studentstatustracker.web.app', 'studentstatustracker.firebaseapp.com'].includes(window.location.hostname)
    ? 'https://statustracker-c1029--statustracker-c1029.us-east4.hosted.app'
    : ''
)).replace(/\/$/, '');

// --- Firebase Initialization ---
const app = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth = (app ? getAuth(app) : null) as ReturnType<typeof getAuth>;
const db = (app ? getFirestore(app) : null) as ReturnType<typeof getFirestore>;

// --- Theme Colors ---
const theme = {
  ink: '#1B2A4A',
  inkSoft: '#3B4A6B',
  paper: '#F6F3EA',
  paperLine: '#DDD6C3',
  gold: '#B98A2E',
  mastered: '#3F7D58',
  masteredBg: '#E4EFE6',
  remaining: '#8B8470',
  remainingBg: '#EDEAE0',
  urgent: '#B5482A',
  urgentBg: '#F6E4DC'
};

// --- Helpers: PDF extraction and secure OpenAI proxy ---
const loadPdfJs = () => new Promise<void>((resolve, reject) => {
  if (window.pdfjsLib) return resolve();
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  script.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    resolve();
  };
  script.onerror = reject;
  document.head.appendChild(script);
});

const extractTextFromPdf = async (file) => {
  await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
};

const callOpenAI = async (action, payload) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  try {
    const idToken = await auth.currentUser?.getIdToken();
    const response = await fetch(`${hostedApiOrigin}/api/openai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
      },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `AI request failed (${response.status})`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The AI request timed out. Please try again.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

const extractTopicsWithOpenAI = async (text) => {
  const data = await callOpenAI('extractTopics', { text: text.substring(0, 100000) });
  return data.topics || [];
};

const analyzeAleksReportWithOpenAI = async (text, courseTopics) => {
  return callOpenAI('analyzeAleksReport', {
    text: text.substring(0, 100000),
    topics: courseTopics.map(({ id, title }) => ({ id, title }))
  });
};

const getTopics = (course) => Array.isArray(course?.topics) ? course.topics : [];
const profileDisplayName = profile => profile?.role === 'student'
  ? (profile?.displayName || [profile?.firstName, profile?.secondName].filter(Boolean).join(' ') || profile?.name || 'Student')
  : (profile?.username || profile?.name || 'Instructor');
const normalizeUsername = value => value.trim().toLowerCase();
const usernameError = value => /^[A-Za-z0-9._-]{3,24}$/.test(value)
  ? ''
  : 'Use 3–24 characters: letters, numbers, periods, underscores, or hyphens.';
const studentNameError = value => /^[\p{L}][\p{L}' -]{0,39}$/u.test(value)
  ? ''
  : 'Use 1–40 letters; apostrophes, spaces, and hyphens are allowed.';

const authErrorMessage = error => {
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'The email or password is incorrect.';
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return 'That email already has an account. Choose Sign in instead.';
    case 'auth/weak-password':
      return 'Use a password with at least 6 characters.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/missing-email':
      return 'Enter your email address first.';
    case 'auth/operation-not-allowed':
      return 'Email/password login must be enabled in Firebase Authentication.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    default:
      return error?.message || 'Authentication could not be completed.';
  }
};

const weekStartFor = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
};

const weekLabel = (weekStart) => {
  if (!weekStart) return 'Unknown week';
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const format: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, format)} - ${end.toLocaleDateString(undefined, format)}`;
};

const usageForStudent = (records, studentId) => records
  .filter(record => record.studentId === studentId)
  .sort((a, b) => String(b.weekStart || '').localeCompare(String(a.weekStart || '')));

const latestReportFor = (reports, courseId, studentId) => reports
  .filter(report => report.courseId === courseId && report.studentId === studentId)
  .sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime())[0] || null;

const manualCompletionsFor = (records, courseId, studentId, courseTopics = []) => {
  const validIds = new Set(courseTopics.map(topic => topic.id));
  const byTopic = new Map();
  records
    .filter(record => record.courseId === courseId && record.studentId === studentId && validIds.has(record.topicId))
    .forEach(record => byTopic.set(record.topicId, record));
  return [...byTopic.values()];
};

const progressFromReport = (report, fallbackTotal = 0) => {
  const summary = report?.summary || {};
  const mastered = Number(summary.mastered) || 0;
  const learned = Number(summary.learned) || 0;
  const readyToLearn = Number(summary.readyToLearn) || 0;
  const remaining = Number(summary.remaining) || 0;
  const total = Number(summary.total) || fallbackTotal || mastered + learned + remaining;
  const completed = mastered + learned;
  return { mastered, learned, readyToLearn, remaining, total, completed, pct: total ? Math.round((completed / total) * 100) : 0 };
};

const combinedProgress = (report, manualRecords, courseTopics) => {
  const base = progressFromReport(report, courseTopics.length);
  const reportStatuses = new Map<string, string>((report?.topicStatuses || []).map(item => [String(item.topicId), String(item.status)]));
  const extraManual = manualRecords.filter(record => !['mastered', 'learned'].includes(reportStatuses.get(record.topicId)));
  if (!report) {
    const total = courseTopics.length;
    const completed = Math.min(total, extraManual.length);
    return { ...base, mastered: 0, remaining: Math.max(0, total - completed), total, completed, manualCompleted: completed, pct: total ? Math.round((completed / total) * 100) : 0 };
  }
  const completed = Math.min(base.total, base.completed + extraManual.length);
  const readyCompleted = extraManual.filter(record => reportStatuses.get(record.topicId) === 'readyToLearn').length;
  return {
    ...base,
    mastered: base.mastered,
    readyToLearn: Math.max(0, base.readyToLearn - readyCompleted),
    remaining: Math.max(0, base.remaining - extraManual.length),
    completed,
    manualCompleted: extraManual.length,
    pct: base.total ? Math.round((completed / base.total) * 100) : 0
  };
};

const reportTopicsByStatus = (report, status, courseTopics) => {
  const ids = new Set((report?.topicStatuses || []).filter(item => item.status === status).map(item => item.topicId));
  return courseTopics.filter(topic => ids.has(topic.id));
};

const validateTopics = (topics) => {
  if (!topics.length) return 'Add at least one topic.';
  if (topics.some(t => !t.id?.trim() || !t.title?.trim() || !t.group?.trim())) return 'Every topic needs an ID, title, and group.';
  const ids = topics.map(t => t.id.trim().toLowerCase());
  if (new Set(ids).size !== ids.length) return 'Topic IDs must be unique.';
  return '';
};

// --- Main Application Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [loadingProfile, setLoadingProfile] = useState(false);
  
  // Data State
  const [profile, setProfile] = useState(null);
  const [courses, setCourses] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const [manualCompletions, setManualCompletions] = useState([]);
  const [usage, setUsage] = useState([]);
  const [progressReports, setProgressReports] = useState([]);
  const recordedVisitFor = useRef('');

  // Init Auth
  useEffect(() => {
    if (!auth) {
      setLoadingAuth(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (usr) => {
      setUser(usr);
      setLoadingProfile(Boolean(usr));
      if (!usr) {
        setProfile(null);
        setCourses([]);
        setEnrollments([]);
        setManualCompletions([]);
        setUsage([]);
        setProgressReports([]);
      }
      if (!initialAuthToken || usr) setLoadingAuth(false);
    });

    if (initialAuthToken) {
      signInWithCustomToken(auth, initialAuthToken)
        .catch(err => console.error('Auth error:', err))
        .finally(() => setLoadingAuth(false));
    }
    return () => unsubscribe();
  }, []);

  // Fetch Data
  useEffect(() => {
    if (!user || !db) return;

    const profileRef = collection(db, 'artifacts', appId, 'users', user.uid, 'profile');
    const coursesRef = collection(db, 'artifacts', appId, 'public', 'data', 'courses');
    const enrollRef = collection(db, 'artifacts', appId, 'public', 'data', 'enrollments');
    const masteryRef = collection(db, 'artifacts', appId, 'public', 'data', 'mastery');
    const usageRef = collection(db, 'artifacts', appId, 'public', 'data', 'usage');
    const reportsRef = collection(db, 'artifacts', appId, 'public', 'data', 'progressReports');

    const unsubs = [
      onSnapshot(profileRef, (snap) => {
        if (!snap.empty) setProfile(snap.docs[0].data());
        else setProfile(null);
        setLoadingProfile(false);
      }, error => {
        console.error(error);
        setLoadingProfile(false);
      }),
      onSnapshot(coursesRef, (snap) => {
        setCourses(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, console.error),
      onSnapshot(enrollRef, (snap) => {
        setEnrollments(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, console.error),
      onSnapshot(masteryRef, (snap) => {
        setManualCompletions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, console.error),
      onSnapshot(usageRef, (snap) => {
        setUsage(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, console.error),
      onSnapshot(reportsRef, (snap) => {
        setProgressReports(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, console.error)
    ];

    return () => unsubs.forEach(fn => fn());
  }, [user]);

  // Count one site visit per application load for students, grouped by Monday-starting week.
  useEffect(() => {
    if (!user || !db || profile?.role !== 'student') return;
    if (recordedVisitFor.current === user.uid) return;
    recordedVisitFor.current = user.uid;
    const now = new Date();
    const weekStart = weekStartFor(now);
    const usageRef = doc(db, 'artifacts', appId, 'public', 'data', 'usage', `${user.uid}_${weekStart}`);
    setDoc(usageRef, {
      studentId: user.uid,
      studentName: profileDisplayName(profile),
      weekStart,
      lastVisitAt: now.toISOString(),
      visitCount: increment(1)
    }, { merge: true }).catch(error => {
      recordedVisitFor.current = '';
      console.error('Could not record student usage:', error);
    });
  }, [user, profile]);

  const setRole = async (role, identity) => {
    if (!user || !db) {
      throw new Error('User not authenticated.');
    }
    const profileRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'main');
    if (role === 'instructor') {
      const cleanUsername = String(identity?.username || '').trim();
      const validationError = usernameError(cleanUsername);
      if (validationError) throw new Error(validationError);
      const usernameNormalized = normalizeUsername(cleanUsername);
      const usernameRef = doc(db, 'artifacts', appId, 'public', 'data', 'usernames', usernameNormalized);
      await runTransaction(db, async transaction => {
        const reservation = await transaction.get(usernameRef);
        if (reservation.exists() && reservation.data().uid !== user.uid) {
          throw new Error('That username is already taken.');
        }
        transaction.set(usernameRef, { uid: user.uid, username: cleanUsername, usernameNormalized, role }, { merge: true });
        transaction.set(profileRef, { role, username: cleanUsername, usernameNormalized }, { merge: true });
      });
      return;
    }

    const firstName = String(identity?.firstName || '').trim();
    const secondName = String(identity?.secondName || '').trim();
    const validationError = studentNameError(firstName) || studentNameError(secondName);
    if (validationError) throw new Error(validationError);
    await setDoc(profileRef, { role: 'student', firstName, secondName, displayName: `${firstName} ${secondName}` }, { merge: true });
  };

  const handleLogin = async (email, password) => {
    if (!auth) throw new Error('Firebase is not configured.');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  };

  const handleCreateAccount = async (email, password) => {
    if (!auth) throw new Error('Firebase is not configured.');
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  };

  const handleResetPassword = async email => {
    if (!auth) throw new Error('Firebase is not configured.');
    if (!email.trim()) throw new Error('Enter your email address first.');
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  };

  const handleSecureAnonymousAccount = async (email, password) => {
    if (!user?.isAnonymous) return;
    try {
      const credential = EmailAuthProvider.credential(email.trim(), password);
      const result = await linkWithCredential(user, credential);
      setUser(result.user);
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  };

  const handleLogout = async () => {
    if (!auth) return;
    await signOut(auth);
  };

  if (!firebaseReady) {
    return <ConfigurationRequired />;
  }

  if (loadingAuth) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F6F3EA] text-[#1B2A4A] font-sans"><Loader2 className="animate-spin w-8 h-8 text-[#B98A2E]" /></div>;
  }

  if (!user) {
    return <AccountAccess onLogin={handleLogin} onCreate={handleCreateAccount} onResetPassword={handleResetPassword} />;
  }

  if (loadingProfile) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F6F3EA] text-[#1B2A4A] font-sans"><Loader2 className="animate-spin w-8 h-8 text-[#B98A2E]" /></div>;
  }

  if (!profile) {
    return <RoleSelection onSelect={setRole} />;
  }

  if (user.isAnonymous) {
    return <SecureAccount profile={profile} onSecure={handleSecureAnonymousAccount} onUseDifferentAccount={handleLogout} />;
  }

  return (
    <div className="min-h-screen font-sans" style={{ backgroundColor: theme.paper, color: theme.ink }}>
      {profile.role === 'instructor' ? (
        <InstructorDashboard user={user} profile={profile} courses={courses} enrollments={enrollments} manualCompletions={manualCompletions} usage={usage} progressReports={progressReports} onLogout={handleLogout} />
      ) : (
        <StudentDashboard user={user} profile={profile} courses={courses} enrollments={enrollments} manualCompletions={manualCompletions} usage={usage} progressReports={progressReports} onLogout={handleLogout} />
      )}
    </div>
  );
}

function AccountAccess({ onLogin, onCreate, onResetPassword }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await (mode === 'login' ? onLogin(email, password) : onCreate(email, password));
    } catch (submitError) {
      setError(submitError.message);
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await onResetPassword(email);
      setNotice('Password reset email sent. Check your inbox and spam folder.');
    } catch (resetError) {
      setError(resetError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: theme.paper, color: theme.ink }}>
      <section className="max-w-md w-full bg-white border rounded-xl p-8 shadow-sm" style={{ borderColor: theme.paperLine }}>
        <h1 className="text-3xl font-serif font-bold mb-2 text-center">Status Tracker</h1>
        <p className="text-sm text-center mb-6" style={{ color: theme.inkSoft }}>{mode === 'login' ? 'Sign in to your instructor or student account.' : 'Create secure login credentials first.'}</p>
        <div className="grid grid-cols-2 gap-1 p-1 rounded-lg mb-6" style={{ backgroundColor: theme.paper }}>
          {['login', 'create'].map(item => (
            <button key={item} type="button" onClick={() => { setMode(item); setError(''); setNotice(''); }} className={`py-2 rounded-md text-sm font-semibold ${mode === item ? 'bg-white shadow-sm' : ''}`}>
              {item === 'login' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" required autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setError(''); }} className="w-full px-4 py-2 border rounded text-sm" style={{ borderColor: theme.paperLine }} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium">Password</label>
              {mode === 'login' && (
                <button type="button" onClick={resetPassword} disabled={busy} className="text-xs font-semibold underline disabled:opacity-50" style={{ color: theme.inkSoft }}>
                  Forgot password?
                </button>
              )}
            </div>
            <input type="password" required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} className="w-full px-4 py-2 border rounded text-sm" style={{ borderColor: theme.paperLine }} />
            {mode === 'create' && <p className="text-xs mt-1" style={{ color: theme.inkSoft }}>Use at least 6 characters.</p>}
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {notice && <p role="status" className="text-sm text-green-800">{notice}</p>}
          <button type="submit" disabled={busy || !email.trim() || password.length < 6} className="w-full py-3 rounded text-white font-semibold disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </section>
    </main>
  );
}

function SecureAccount({ profile, onSecure, onUseDifferentAccount }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSecure(email, password);
    } catch (submitError) {
      setError(submitError.message);
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: theme.paper, color: theme.ink }}>
      <section className="max-w-md w-full bg-white border rounded-xl p-8 shadow-sm" style={{ borderColor: theme.paperLine }}>
        <div className="font-mono text-xs uppercase tracking-widest mb-2" style={{ color: theme.gold }}>One-time account upgrade</div>
        <h1 className="text-2xl font-serif font-bold mb-2">Secure {profileDisplayName(profile)}</h1>
        <p className="text-sm mb-6" style={{ color: theme.inkSoft }}>Add an email and password to keep this existing profile and make future login and logout work correctly.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" required autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setError(''); }} className="w-full px-4 py-2 border rounded text-sm" style={{ borderColor: theme.paperLine }} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Create password</label>
            <input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={event => { setPassword(event.target.value); setError(''); }} className="w-full px-4 py-2 border rounded text-sm" style={{ borderColor: theme.paperLine }} />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={busy || !email.trim() || password.length < 6} className="w-full py-3 rounded text-white font-semibold disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
            {busy ? 'Securing account…' : 'Save login and continue'}
          </button>
          <button type="button" onClick={onUseDifferentAccount} disabled={busy} className="w-full py-2 text-sm font-semibold underline disabled:opacity-50" style={{ color: theme.inkSoft }}>
            Use a different account on this browser
          </button>
        </form>
      </section>
    </main>
  );
}

function ConfigurationRequired() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: theme.paper, color: theme.ink }}>
      <section className="max-w-xl w-full bg-white border rounded-xl p-8 shadow-sm" style={{ borderColor: theme.paperLine }}>
        <div className="font-mono text-xs uppercase tracking-widest mb-2" style={{ color: theme.gold }}>Setup required</div>
        <h1 className="text-3xl font-serif font-bold mb-3">Connect Firebase to start</h1>
        <p className="text-sm leading-relaxed mb-5" style={{ color: theme.inkSoft }}>
          The website is running correctly, but it needs your Firebase project details for sign-in and course storage.
        </p>
        <ol className="list-decimal pl-5 text-sm space-y-2 mb-5">
          <li>Copy <code className="bg-slate-100 px-1 rounded">.env.example</code> to <code className="bg-slate-100 px-1 rounded">.env</code>.</li>
          <li>Paste your Firebase web configuration into <code className="bg-slate-100 px-1 rounded">VITE_FIREBASE_CONFIG</code>.</li>
          <li>Restart <code className="bg-slate-100 px-1 rounded">npm run dev</code>.</li>
        </ol>
        <p className="text-xs" style={{ color: theme.inkSoft }}>See README.md for the complete Firebase and OpenAI setup.</p>
      </section>
    </main>
  );
}

// --- Role Selection ---
function RoleSelection({ onSelect }) {
  const [role, setRole] = useState(null);
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [secondName, setSecondName] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!role) return;
    const validationError = role === 'instructor'
      ? usernameError(username.trim())
      : studentNameError(firstName.trim()) || studentNameError(secondName.trim());
    if (validationError) return setError(validationError);
    setIsSaving(true);
    setError('');
    try {
      await onSelect(role, role === 'instructor'
        ? { username: username.trim() }
        : { firstName: firstName.trim(), secondName: secondName.trim() });
    } catch (submitError) {
      setError(submitError.message || 'The profile could not be created.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: theme.paper }}>
      <div className="max-w-md w-full bg-white p-8 rounded-lg shadow-sm border" style={{ borderColor: theme.paperLine }}>
        <h1 className="text-2xl font-serif font-bold mb-2 text-center" style={{ color: theme.ink }}>Welcome to Status Tracker</h1>
        <p className="text-center text-sm mb-8" style={{ color: theme.inkSoft }}>Track weekly usage and current ALEKS course status.</p>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-3">
            <label className="block text-sm font-medium mb-1">I am a...</label>
            <button type="button" onClick={() => setRole('instructor')}
              className={`w-full flex items-center p-4 border rounded-lg transition-colors ${role === 'instructor' ? 'bg-[#F6FAF7] border-[#3F7D58]' : 'hover:bg-gray-50'}`}
              style={{ borderColor: role === 'instructor' ? theme.mastered : theme.paperLine }}
            >
              <BookOpen className="w-6 h-6 mr-3" style={{ color: role === 'instructor' ? theme.mastered : theme.inkSoft }} />
              <div className="text-left">
                <div className="font-semibold" style={{ color: theme.ink }}>Instructor</div>
                <div className="text-xs" style={{ color: theme.inkSoft }}>I want to create courses and track my students.</div>
              </div>
            </button>
            <button type="button" onClick={() => setRole('student')}
              className={`w-full flex items-center p-4 border rounded-lg transition-colors ${role === 'student' ? 'bg-[#F9F7E8] border-[#B98A2E]' : 'hover:bg-gray-50'}`}
              style={{ borderColor: role === 'student' ? theme.gold : theme.paperLine }}
            >
              <Users className="w-6 h-6 mr-3" style={{ color: role === 'student' ? theme.gold : theme.inkSoft }} />
              <div className="text-left">
                <div className="font-semibold" style={{ color: theme.ink }}>Student</div>
                <div className="text-xs" style={{ color: theme.inkSoft }}>I want to track my site usage and ALEKS course status.</div>
              </div>
            </button>
          </div>

          {role === 'instructor' && (
            <div>
              <label className="block text-sm font-medium mb-1">Username</label>
              <input type="text" required value={username} onChange={e => { setUsername(e.target.value); setError(''); }} minLength={3} maxLength={24}
                className="w-full px-4 py-2 border rounded font-mono text-sm focus:outline-none focus:ring-1 focus:ring-[#B98A2E]"
                style={{ borderColor: theme.paperLine }} placeholder="e.g. prof.jones" autoComplete="username" />
              <p className="text-xs mt-1" style={{ color: theme.inkSoft }}>Must be unique. Use letters, numbers, periods, underscores, or hyphens.</p>
            </div>
          )}

          {role === 'student' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">First name</label>
                <input type="text" required value={firstName} onChange={e => { setFirstName(e.target.value); setError(''); }} maxLength={40}
                  className="w-full px-4 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#B98A2E]"
                  style={{ borderColor: theme.paperLine }} placeholder="e.g. Jane" autoComplete="given-name" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Second name</label>
                <input type="text" required value={secondName} onChange={e => { setSecondName(e.target.value); setError(''); }} maxLength={40}
                  className="w-full px-4 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#B98A2E]"
                  style={{ borderColor: theme.paperLine }} placeholder="e.g. Doe" autoComplete="family-name" />
              </div>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

          <button type="submit" disabled={!role || isSaving || (role === 'instructor' ? !username.trim() : !firstName.trim() || !secondName.trim())}
            className="w-full py-3 rounded text-white font-semibold transition-opacity disabled:opacity-50"
            style={{ backgroundColor: theme.ink }}
          >
            {isSaving ? 'Creating profile…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}

// --- Instructor Views ---
function InstructorDashboard({ user, profile, courses, enrollments, manualCompletions, usage, progressReports, onLogout }) {
  const [view, setView] = useState('list'); // 'list', 'create', 'course'
  const [activeCourseId, setActiveCourseId] = useState(null);

  const myCourses = courses.filter(c => c.instructorId === user.uid);
  const activeCourse = courses.find(c => c.id === activeCourseId);

  return (
    <div className="max-w-5xl mx-auto p-6 pb-20">
      <header className="mb-8 flex justify-between items-end border-b pb-4" style={{ borderColor: theme.paperLine }}>
        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: theme.gold }}>Instructor Portal</div>
          <h1 className="text-3xl font-serif font-bold" style={{ color: theme.ink }}>Welcome, {profileDisplayName(profile)}</h1>
        </div>
        <div className="flex items-center gap-3">
          {view === 'list' && (
            <button onClick={() => setView('create')} className="hidden sm:flex px-4 py-2 rounded text-white text-sm font-semibold items-center" style={{ backgroundColor: theme.ink }}>
              <Plus className="w-4 h-4 mr-2" /> New Course
            </button>
          )}
          <button onClick={onLogout} className="flex items-center gap-2 px-3 py-2 text-sm rounded border transition-colors hover:bg-white text-red-800" style={{ borderColor: theme.paperLine }}>
            <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Log out</span>
          </button>
        </div>
      </header>

      {view === 'list' && (
        <>
          <div className="sm:hidden mb-4">
            <button onClick={() => setView('create')} className="w-full justify-center px-4 py-3 rounded text-white text-sm font-semibold flex items-center" style={{ backgroundColor: theme.ink }}>
              <Plus className="w-4 h-4 mr-2" /> New Course
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {myCourses.length === 0 ? (
              <div className="col-span-full bg-white border p-8 rounded-lg text-center" style={{ borderColor: theme.paperLine }}>
                <div className="text-sm mb-4" style={{ color: theme.inkSoft }}>You haven't created any courses yet.</div>
                <button onClick={() => setView('create')} className="px-4 py-2 rounded text-sm font-semibold border" style={{ borderColor: theme.paperLine, color: theme.ink }}>
                  Create your first course
                </button>
              </div>
            ) : (
              myCourses.map(course => {
                const studentsCount = enrollments.filter(e => e.courseId === course.id).length;
                return (
                  <div key={course.id} role="button" tabIndex={0} onClick={() => { setActiveCourseId(course.id); setView('course'); }}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveCourseId(course.id); setView('course'); } }}
                    className="bg-white border p-5 rounded-lg cursor-pointer hover:shadow-sm transition-shadow group" style={{ borderColor: theme.paperLine }}>
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-serif font-bold text-lg">{course.name}</h3>
                      <ChevronRight className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: theme.gold }} />
                    </div>
                    <div className="font-mono text-xs mb-4" style={{ color: theme.inkSoft }}>Code: <span className="font-bold text-black">{course.code}</span></div>
                    <div className="flex justify-between text-sm" style={{ color: theme.inkSoft }}>
                      <span>{course.topics?.length || 0} Topics</span>
                      <span>{studentsCount} Students</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {view === 'create' && <CourseBuilder user={user} courses={courses} onCancel={() => setView('list')} onCreated={() => setView('list')} />}
      
      {view === 'course' && activeCourse && (
        <InstructorCourseView course={activeCourse} enrollments={enrollments} manualCompletions={manualCompletions} usage={usage} progressReports={progressReports} onBack={() => { setView('list'); setActiveCourseId(null); }} />
      )}
    </div>
  );
}

function CourseBuilder({ user, courses, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [extractedTopics, setExtractedTopics] = useState(null);

  const handleTopicChange = (index, field, value) => {
    const newTopics = [...extractedTopics];
    newTopics[index][field] = value;
    setExtractedTopics(newTopics);
  };

  const handleAddTopic = () => {
    setExtractedTopics([...extractedTopics, { id: `T${extractedTopics.length + 1}`, title: 'New Topic', group: 'General' }]);
  };

  const handleRemoveTopic = (index) => {
    setExtractedTopics(extractedTopics.filter((_, i) => i !== index));
  };

  const handleFileUpload = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setStatus("Please enter a course name first.");
    if (files.length === 0) return setStatus("Please select at least one PDF syllabus or schedule.");
    if (files.some(file => file.type !== 'application/pdf' || file.size > 15 * 1024 * 1024)) {
      return setStatus("Use PDF files no larger than 15 MB each.");
    }

    setIsProcessing(true);
    setStatus("Extracting text from PDFs (this happens locally in your browser)...");
    
    try {
      let combinedText = '';
      for (let i = 0; i < files.length; i++) {
        setStatus(`Extracting text from PDF ${i + 1} of ${files.length}...`);
        const text = await extractTextFromPdf(files[i]);
        combinedText += `\n--- Document: ${files[i].name} ---\n${text}\n`;
      }
      if (!combinedText.replace(/--- Document:[\s\S]*?---/g, '').trim()) {
        throw new Error('No selectable text was found. Scanned PDFs need OCR before upload.');
      }
      
      setStatus("Analyzing documents with AI to find learning topics...");
      const topics = await extractTopicsWithOpenAI(combinedText);
      
      if (topics && topics.length > 0) {
        setExtractedTopics(topics);
        setStatus('');
      } else {
        setStatus("Could not identify any topics. Please check the PDF format.");
      }
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveCourse = async () => {
    if (!extractedTopics) return;
    const cleanedTopics = extractedTopics.map(topic => ({
      id: topic.id.trim(),
      title: topic.title.trim(),
      group: topic.group.trim()
    }));
    const validationError = validateTopics(cleanedTopics);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setIsProcessing(true);
    try {
      let courseCode;
      do {
        courseCode = Math.random().toString(36).slice(2, 8).toUpperCase();
      } while (courses.some(course => course.code === courseCode));
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'courses'), {
        instructorId: user.uid,
        name: name.trim(),
        code: courseCode,
        topics: cleanedTopics,
        createdAt: new Date().toISOString()
      });
      onCreated();
    } catch (err) {
      setStatus("Error saving course: " + err.message);
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-white border rounded-lg p-6 max-w-2xl" style={{ borderColor: theme.paperLine }}>
      <button onClick={onCancel} className="flex items-center text-sm mb-6 font-medium hover:underline" style={{ color: theme.inkSoft }}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
      </button>
      
      <h2 className="text-2xl font-serif font-bold mb-4" style={{ color: theme.ink }}>Build New Course Tracker</h2>
      
      {!extractedTopics ? (
        <form onSubmit={handleFileUpload} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1">Course Name</label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)}
              className="w-full px-4 py-2 border rounded text-sm focus:outline-none"
              style={{ borderColor: theme.paperLine }} placeholder="e.g. Introduction to Statistics Fall 2026" />
          </div>
          
          <div className="border-2 border-dashed rounded-lg p-8 text-center" style={{ borderColor: theme.gold }}>
            <Upload className="w-8 h-8 mx-auto mb-3" style={{ color: theme.gold }} />
            <h3 className="font-serif font-bold mb-1">Upload ALEKS Syllabus & Course Materials</h3>
            <p className="text-xs mb-4" style={{ color: theme.inkSoft }}>Upload the ALEKS syllabus and any course schedule, topic list, or pacing guide PDFs. AI will combine the files, extract the learning topics, and reconcile naming differences.</p>
            <input type="file" accept="application/pdf" multiple required onChange={e => setFiles(Array.from(e.target.files || []))}
              className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
            {files.length > 0 && (
              <div className="mt-4 text-xs text-left max-h-32 overflow-y-auto bg-slate-50 p-2 rounded border border-slate-100">
                <div className="font-semibold text-slate-700 mb-1">Selected files ({files.length}):</div>
                {files.map((f, i) => <div key={i} className="truncate text-slate-500" title={f.name}>- {f.name}</div>)}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span role="status" aria-live="polite" className="text-sm font-mono" style={{ color: theme.inkSoft }}>{status}</span>
            <button type="submit" disabled={isProcessing} className="px-6 py-2 rounded text-white font-semibold flex items-center disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
              {isProcessing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Analyze PDF
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="bg-[#E4EFE6] border border-[#3F7D58] text-[#3F7D58] p-4 rounded-lg flex items-start">
            <CheckCircle2 className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-sm">Successfully extracted {extractedTopics.length} topics!</div>
              <div className="text-xs mt-1">Review and edit the list below. You can change titles, fix IDs, or add missing topics before creating the course.</div>
            </div>
          </div>
          
          <div className="max-h-96 overflow-y-auto border rounded bg-slate-50 p-3 space-y-3" style={{ borderColor: theme.paperLine }}>
            {extractedTopics.map((t, i) => (
              <div key={i} className="p-3 bg-white border rounded shadow-sm flex gap-3 items-start" style={{ borderColor: theme.paperLine }}>
                <div className="flex flex-col gap-1 w-20 shrink-0">
                  <label className="text-[10px] font-bold text-slate-500 uppercase">ID</label>
                  <input 
                    value={t.id} 
                    onChange={(e) => handleTopicChange(i, 'id', e.target.value)}
                    className="font-mono text-xs w-full px-2 py-1.5 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" 
                    placeholder="e.g. T1"
                  />
                </div>
                <div className="flex-1 flex flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Topic Title</label>
                    <input 
                      value={t.title} 
                      onChange={(e) => handleTopicChange(i, 'title', e.target.value)}
                      className="w-full px-2 py-1.5 border rounded font-medium text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" 
                      placeholder="Topic Name"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Group / Chapter</label>
                    <input 
                      value={t.group} 
                      onChange={(e) => handleTopicChange(i, 'group', e.target.value)}
                      className="w-full px-2 py-1.5 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" 
                      placeholder="e.g. Chapter 1"
                    />
                  </div>
                </div>
                <button onClick={() => handleRemoveTopic(i)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors mt-4">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button onClick={handleAddTopic} className="w-full py-3 mt-2 border-2 border-dashed rounded text-sm text-slate-600 hover:bg-slate-100 hover:border-slate-400 flex items-center justify-center transition-colors">
              <Plus className="w-4 h-4 mr-2"/> Add Missing Topic
            </button>
          </div>

          <div className="flex justify-end gap-3">
            {status && <span role="status" aria-live="polite" className="mr-auto self-center text-sm text-red-700">{status}</span>}
            <button onClick={() => setExtractedTopics(null)} className="px-4 py-2 rounded text-sm border font-medium" style={{ borderColor: theme.paperLine, color: theme.ink }}>Discard & Try Again</button>
            <button onClick={handleSaveCourse} disabled={isProcessing || extractedTopics.length === 0} className="px-6 py-2 rounded text-white font-semibold flex items-center disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
              {isProcessing ? 'Saving...' : 'Create Course'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function InstructorCourseView({ course, enrollments, manualCompletions, usage, progressReports, onBack }) {
  const [expandedStudentId, setExpandedStudentId] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedTopics, setEditedTopics] = useState(getTopics(course).map(topic => ({ ...topic })));
  const [isSaving, setIsSaving] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [copied, setCopied] = useState(false);
  const courseTopics = getTopics(course);

  // Keep editor state in sync if the course updates while viewing
  useEffect(() => {
    setEditedTopics(courseTopics.map(topic => ({ ...topic })));
    setEditorError('');
  }, [course.topics]);

  const courseStudents = enrollments.filter(e => e.courseId === course.id);
  
  const toggleStudent = (studentId) => {
    setExpandedStudentId(prev => prev === studentId ? null : studentId);
  };

  const handleTopicChange = (index, field, value) => {
    setEditedTopics(current => current.map((topic, topicIndex) => topicIndex === index ? { ...topic, [field]: value } : topic));
  };

  const handleAddTopic = () => {
    setEditedTopics([...editedTopics, { id: `T${editedTopics.length + 1}`, title: 'New Topic', group: 'General' }]);
  };

  const handleRemoveTopic = (index) => {
    setEditedTopics(editedTopics.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    const cleanedTopics = editedTopics.map(topic => ({
      id: topic.id.trim(),
      title: topic.title.trim(),
      group: topic.group.trim()
    }));
    const validationError = validateTopics(cleanedTopics);
    if (validationError) {
      setEditorError(validationError);
      return;
    }
    setIsSaving(true);
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'courses', course.id), {
        topics: cleanedTopics
      });
      setIsEditing(false);
    } catch(err) {
      setEditorError("Error saving topics: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} className="flex items-center text-sm mb-6 font-medium hover:underline" style={{ color: theme.inkSoft }}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
      </button>
      
      <div className="bg-white border rounded-lg p-6 mb-6 flex flex-wrap gap-6 justify-between items-start" style={{ borderColor: theme.paperLine }}>
        <div>
          <h2 className="text-2xl font-serif font-bold mb-1">{course.name}</h2>
          <div className="text-sm" style={{ color: theme.inkSoft }}>{courseTopics.length} Total Topics &middot; {courseStudents.length} Students Enrolled</div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button 
            onClick={() => {
              if (isEditing) {
                setEditedTopics(courseTopics.map(topic => ({ ...topic }))); // Reset on cancel
                setIsEditing(false);
              } else {
                setIsEditing(true);
              }
            }}
            className="px-4 py-2 border rounded text-sm font-semibold transition-colors hover:bg-gray-50"
            style={{ borderColor: theme.paperLine, color: theme.ink }}
          >
            {isEditing ? 'Cancel Edit' : 'Edit Topics'}
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(course.code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              } catch {
                setCopied(false);
              }
            }}
            className="bg-[#F6FAF7] border border-[#BFDCC5] p-3 rounded text-center min-w-[120px] hover:bg-[#E4EFE6]"
            aria-label="Copy invite code"
          >
            <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: theme.mastered }}>Invite Code</div>
            <div className="font-mono text-xl font-bold tracking-widest flex items-center justify-center gap-2">{course.code} <Copy className="w-3.5 h-3.5" /></div>
            {copied && <div className="text-[10px] mt-1" style={{ color: theme.mastered }}>Copied</div>}
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="bg-white border rounded-lg p-6 mb-6" style={{ borderColor: theme.paperLine }}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-serif font-bold text-lg">Edit Course Topics</h3>
            <button onClick={handleSave} disabled={isSaving} className="px-6 py-2 rounded text-white font-semibold flex items-center disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save Changes
            </button>
          </div>
          {editorError && <p role="alert" className="text-sm text-red-700 mb-3">{editorError}</p>}
          <div className="max-h-96 overflow-y-auto border rounded bg-slate-50 p-3 space-y-3" style={{ borderColor: theme.paperLine }}>
            {editedTopics.map((t, i) => (
              <div key={i} className="p-3 bg-white border rounded shadow-sm flex gap-3 items-start" style={{ borderColor: theme.paperLine }}>
                <div className="flex flex-col gap-1 w-20 shrink-0">
                  <label className="text-[10px] font-bold text-slate-500 uppercase">ID</label>
                  <input 
                    value={t.id}
                    disabled={courseTopics.some(topic => topic.id === t.id)}
                    onChange={(e) => handleTopicChange(i, 'id', e.target.value)}
                    className="font-mono text-xs w-full px-2 py-1.5 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500" 
                    placeholder="e.g. T1"
                  />
                </div>
                <div className="flex-1 flex flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Topic Title</label>
                    <input 
                      value={t.title} 
                      onChange={(e) => handleTopicChange(i, 'title', e.target.value)}
                      className="w-full px-2 py-1.5 border rounded font-medium text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" 
                      placeholder="Topic Name"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Group / Chapter</label>
                    <input 
                      value={t.group} 
                      onChange={(e) => handleTopicChange(i, 'group', e.target.value)}
                      className="w-full px-2 py-1.5 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" 
                      placeholder="e.g. Chapter 1"
                    />
                  </div>
                </div>
                <button onClick={() => handleRemoveTopic(i)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors mt-4">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button onClick={handleAddTopic} className="w-full py-3 mt-2 border-2 border-dashed rounded text-sm text-slate-600 hover:bg-slate-100 hover:border-slate-400 flex items-center justify-center transition-colors">
              <Plus className="w-4 h-4 mr-2"/> Add Missing Topic
            </button>
          </div>
        </div>
      ) : (
        <>
          <CourseAssistant
            role="instructor"
            course={course}
            progress={courseStudents.map((student, index) => ({
              studentLabel: `Student ${index + 1}`,
              currentProgress: combinedProgress(
                latestReportFor(progressReports, course.id, student.studentId),
                manualCompletionsFor(manualCompletions, course.id, student.studentId, courseTopics),
                courseTopics
              ),
              weeklyVisits: usageForStudent(usage, student.studentId).slice(0, 8).map(record => ({ weekStart: record.weekStart, visitCount: record.visitCount }))
            }))}
          />
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="font-serif font-bold text-lg">Student Usage</h3>
            <p className="text-xs" style={{ color: theme.inkSoft }}>Visits are grouped by week. ALEKS progress updates immediately after each PDF upload.</p>
          </div>
          <div className="bg-white border rounded-lg overflow-hidden" style={{ borderColor: theme.paperLine }}>
          {courseStudents.length === 0 ? (
            <div className="p-8 text-center text-sm" style={{ color: theme.inkSoft }}>No students have joined this course yet.<br/>Share the invite code <b>{course.code}</b> with them.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm min-w-[980px]">
                <thead className="bg-[#FBFAF5] border-b" style={{ borderColor: theme.paperLine }}>
                  <tr>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Student Name</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>This Week</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Total Visits</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Last Visit</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Mastered</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Learned</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Manual</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Ready</th>
                    <th className="p-4 font-mono font-medium text-xs tracking-wider uppercase" style={{ color: theme.inkSoft }}>Current Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y" style={{ borderColor: theme.paperLine }}>
                  {courseStudents.map(student => {
                    const report = latestReportFor(progressReports, course.id, student.studentId);
                    const studentManual = manualCompletionsFor(manualCompletions, course.id, student.studentId, courseTopics);
                    const aleksCompleteIds = new Set((report?.topicStatuses || []).filter(item => item.status === 'mastered' || item.status === 'learned').map(item => item.topicId));
                    const effectiveManual = studentManual.filter(record => !aleksCompleteIds.has(record.topicId));
                    const stats = combinedProgress(report, studentManual, courseTopics);
                    const studentUsage = usageForStudent(usage, student.studentId);
                    const thisWeekVisits = Number(studentUsage.find(record => record.weekStart === weekStartFor())?.visitCount) || 0;
                    const totalVisits = studentUsage.reduce((sum, record) => sum + (Number(record.visitCount) || 0), 0);
                    const lastVisit = studentUsage[0]?.lastVisitAt;
                    const expanded = expandedStudentId === student.studentId;
                    
                    return (
                      <React.Fragment key={student.id}>
                        <tr className="hover:bg-gray-50">
                          <td className="p-4 font-medium">
                            <button type="button" onClick={() => toggleStudent(student.studentId)} className="flex items-center gap-2 text-left hover:underline" aria-expanded={expanded}>
                              <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                              {student.studentName || student.studentUsername || 'Student'}
                            </button>
                          </td>
                          <td className="p-4 font-mono text-xs">{thisWeekVisits}</td>
                          <td className="p-4 font-mono text-xs">{totalVisits}</td>
                          <td className="p-4 font-mono text-xs whitespace-nowrap">{lastVisit ? new Date(lastVisit).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No visits'}</td>
                          <td className="p-4 font-mono text-xs">{report ? stats.mastered : '—'}</td>
                          <td className="p-4 font-mono text-xs">{report ? stats.learned : '—'}</td>
                          <td className="p-4 font-mono text-xs">{stats.manualCompleted}</td>
                          <td className="p-4 font-mono text-xs">{report ? stats.readyToLearn : '—'}</td>
                          <td className="p-4">
                              <div className="flex items-center gap-3">
                                <div className="w-full bg-[#EDEAE0] h-2 rounded-full overflow-hidden">
                                  <div className="bg-[#3F7D58] h-full" style={{ width: `${stats.pct}%` }}></div>
                                </div>
                                <span className="font-mono text-xs w-8 text-right">{report ? `${stats.pct}%` : '—'}</span>
                              </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-[#FBFAF5]">
                            <td colSpan={9} className="p-5 pl-10">
                              <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
                                <div>
                                  <div className="text-xs font-semibold mb-2">Weekly site visits</div>
                                  {studentUsage.length ? (
                                    <div className="space-y-1.5">
                                      {studentUsage.slice(0, 8).map(record => (
                                        <div key={record.id} className="flex justify-between text-xs border-b border-dashed pb-1.5" style={{ borderColor: theme.paperLine }}>
                                          <span>{weekLabel(record.weekStart)}</span>
                                          <span className="font-mono font-semibold">{record.visitCount} visit{Number(record.visitCount) === 1 ? '' : 's'}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <div className="text-xs" style={{ color: theme.inkSoft }}>No recorded visits yet.</div>}
                                </div>
                                <div>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mb-3" style={{ color: theme.inkSoft }}>
                                    <span>Latest report: {report?.reportDate || 'Not uploaded'}</span>
                                    {report?.uploadedAt && <span>Synced {new Date(report.uploadedAt).toLocaleString()}</span>}
                                  </div>
                                  {report ? (
                                    <div className="space-y-3">
                                      {[
                                        ['Mastered', 'mastered', '#E4EFE6', '#3F7D58'],
                                        ['Learned', 'learned', '#E6EEF8', '#315E8A'],
                                        ['Ready to learn', 'readyToLearn', '#F4EAD3', '#8A641F']
                                      ].map(([label, status, bg, color]) => {
                                        const topics = reportTopicsByStatus(report, status, courseTopics);
                                        return (
                                          <div key={status}>
                                            <div className="text-xs font-semibold mb-1.5">{label} ({topics.length} matched)</div>
                                            <div className="flex flex-wrap gap-1.5">
                                              {topics.length ? topics.map(topic => <span key={topic.id} className="px-2 py-1 rounded text-xs" style={{ backgroundColor: bg, color }}>{topic.title}</span>) : <span className="text-xs" style={{ color: theme.inkSoft }}>No matched topics.</span>}
                                            </div>
                                          </div>
                                        );
                                      })}
                                      <div>
                                        <div className="text-xs font-semibold mb-1.5">Manually completed ({effectiveManual.length})</div>
                                        <div className="flex flex-wrap gap-1.5">
                                          {effectiveManual.length ? effectiveManual.map(record => {
                                            const topic = courseTopics.find(item => item.id === record.topicId);
                                            return topic ? <span key={record.id} className="px-2 py-1 rounded text-xs bg-[#EEE8F7] text-[#65458A]">{topic.title}</span> : null;
                                          }) : <span className="text-xs" style={{ color: theme.inkSoft }}>No manually completed topics.</span>}
                                        </div>
                                      </div>
                                    </div>
                                  ) : <div className="text-xs" style={{ color: theme.inkSoft }}>Waiting for the student to upload an ALEKS Pie Report PDF.</div>}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
}

function CourseAssistant({ role, course, topicStatuses = [], progress = [] }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const topics = getTopics(course);
  const suggestions = role === 'instructor'
    ? ['Summarize class progress', 'Suggest a review lesson', 'Which topics need attention?']
    : ['What should I study next?', 'Make me a short study plan', 'Quiz me on a remaining topic'];

  const askAssistant = async (prompt = question) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isLoading) return;
    setIsOpen(true);
    setQuestion(cleanPrompt);
    setError('');
    setAnswer('');
    setIsLoading(true);
    try {
      const data = await callOpenAI('courseAssistant', {
        role,
        question: cleanPrompt,
        course: { name: course.name, topics },
        topicStatuses,
        progress
      });
      setAnswer(data.answer || 'No answer was returned.');
    } catch (err) {
      setError(err.message || 'The assistant is unavailable right now.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="bg-white border rounded-lg mb-6 overflow-hidden" style={{ borderColor: theme.paperLine }}>
      <button type="button" onClick={() => setIsOpen(value => !value)} className="w-full p-4 flex items-center justify-between text-left hover:bg-[#FBFAF5]" aria-expanded={isOpen}>
        <span className="flex items-center gap-3">
          <span className="p-2 rounded-full bg-[#F4EAD3]" style={{ color: theme.gold }}><Sparkles className="w-5 h-5" /></span>
          <span>
            <span className="block font-serif font-bold">ChatGPT course assistant</span>
            <span className="block text-xs mt-0.5" style={{ color: theme.inkSoft }}>{role === 'instructor' ? 'Turn live progress into teaching actions.' : 'Get guidance grounded in your course progress.'}</span>
          </span>
        </span>
        <ChevronDown className={`w-5 h-5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="border-t p-4" style={{ borderColor: theme.paperLine }}>
          <div className="flex flex-wrap gap-2 mb-3">
            {suggestions.map(suggestion => (
              <button key={suggestion} type="button" onClick={() => askAssistant(suggestion)} disabled={isLoading} className="text-xs px-3 py-1.5 rounded-full border hover:bg-[#F6F3EA] disabled:opacity-50" style={{ borderColor: theme.paperLine }}>
                {suggestion}
              </button>
            ))}
          </div>
          <form onSubmit={event => { event.preventDefault(); askAssistant(); }} className="flex gap-2">
            <input value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} placeholder={role === 'instructor' ? 'Ask about pacing, gaps, or lesson planning…' : 'Ask for an explanation, plan, or practice question…'} className="flex-1 min-w-0 px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1" style={{ borderColor: theme.paperLine }} />
            <button type="submit" disabled={isLoading || !question.trim()} className="px-4 py-2 rounded text-white disabled:opacity-50" style={{ backgroundColor: theme.ink }} aria-label="Ask ChatGPT">
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </form>
          <div aria-live="polite">
            {isLoading && <p className="text-sm mt-3" style={{ color: theme.inkSoft }}>Thinking…</p>}
            {error && <p role="alert" className="text-sm mt-3 text-red-700">{error}</p>}
            {answer && <div className="text-sm mt-3 p-4 rounded bg-[#F6F3EA] whitespace-pre-wrap leading-relaxed">{answer}</div>}
          </div>
        </div>
      )}
    </section>
  );
}

// --- Student Views ---
function StudentDashboard({ user, profile, courses, enrollments, manualCompletions, usage, progressReports, onLogout }) {
  const [activeCourseId, setActiveCourseId] = useState(null);
  
  const myEnrollments = enrollments.filter(e => e.studentId === user.uid);
  const myCourses = myEnrollments.map(e => courses.find(c => c.id === e.courseId)).filter(Boolean);
  const activeCourse = courses.find(c => c.id === activeCourseId);

  if (activeCourse) {
    return <StudentCourseTracker user={user} profile={profile} course={activeCourse} manualCompletions={manualCompletions} usage={usage} progressReports={progressReports} onBack={() => setActiveCourseId(null)} onLogout={onLogout} />;
  }

  return (
    <div className="max-w-5xl mx-auto p-6 pb-20">
      <header className="mb-8 flex flex-col md:flex-row justify-between md:items-end gap-6 border-b pb-4" style={{ borderColor: theme.paperLine }}>
        <div className="flex justify-between items-start w-full md:w-auto">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: theme.gold }}>Student Portal</div>
            <h1 className="text-3xl font-serif font-bold" style={{ color: theme.ink }}>Hi, {profileDisplayName(profile)}</h1>
          </div>
          <button onClick={onLogout} className="md:hidden flex items-center gap-2 px-3 py-2 text-sm rounded border transition-colors hover:bg-white text-red-800" style={{ borderColor: theme.paperLine }}>
            <LogOut className="w-4 h-4" /> 
          </button>
        </div>
        
        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="flex-1 md:flex-none">
            <JoinCourse user={user} profile={profile} courses={courses} enrollments={enrollments} />
          </div>
          <button onClick={onLogout} className="hidden md:flex items-center gap-2 px-3 py-2 text-sm rounded border transition-colors hover:bg-white text-red-800" style={{ borderColor: theme.paperLine }}>
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-serif font-bold text-xl">Student Usage</h2>
        <span className="text-xs" style={{ color: theme.inkSoft }}>{usageForStudent(usage, user.uid).reduce((sum, record) => sum + (Number(record.visitCount) || 0), 0)} total site visits</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {myCourses.length === 0 ? (
          <div className="col-span-full bg-white border p-8 rounded-lg text-center" style={{ borderColor: theme.paperLine }}>
            <div className="text-sm mb-4" style={{ color: theme.inkSoft }}>You haven't joined any courses yet.</div>
            <div className="text-xs" style={{ color: theme.inkSoft }}>Use the "Join Course" box above to enter an invite code from your instructor.</div>
          </div>
        ) : (
          myCourses.map(course => {
            const topics = getTopics(course);
            const report = latestReportFor(progressReports, course.id, user.uid);
            const studentManual = manualCompletionsFor(manualCompletions, course.id, user.uid, topics);
            const stats = combinedProgress(report, studentManual, topics);
            const thisWeekVisits = Number(usageForStudent(usage, user.uid).find(record => record.weekStart === weekStartFor())?.visitCount) || 0;
            return (
              <div key={course.id} role="button" tabIndex={0} onClick={() => setActiveCourseId(course.id)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveCourseId(course.id); } }}
                className="bg-white border p-5 rounded-lg cursor-pointer hover:shadow-sm transition-shadow group flex flex-col justify-between" style={{ borderColor: theme.paperLine }}>
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-serif font-bold text-lg pr-4">{course.name}</h3>
                    <ChevronRight className="w-5 h-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: theme.gold }} />
                  </div>
                </div>
                <div className="mt-6">
                  <div className="flex justify-between text-xs font-mono mb-2" style={{ color: theme.inkSoft }}>
                    <span>{report || studentManual.length ? `${stats.completed} / ${stats.total} complete` : 'Upload a report or mark topics complete'}</span>
                    <span>{report || studentManual.length ? `${stats.pct}%` : `${thisWeekVisits} visits this week`}</span>
                  </div>
                  <div className="w-full bg-[#EDEAE0] h-1.5 rounded-full overflow-hidden">
                    <div className="bg-[#3F7D58] h-full" style={{ width: `${stats.pct}%` }}></div>
                  </div>
                  {report && <div className="flex flex-wrap gap-3 mt-3 text-[11px] font-mono" style={{ color: theme.inkSoft }}><span>{stats.mastered} mastered</span><span>{stats.learned} learned</span><span>{stats.readyToLearn} ready</span></div>}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function JoinCourse({ user, profile, courses, enrollments }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    
    const course = courses.find(c => c.code?.toUpperCase() === code.trim().toUpperCase());
    if (!course) {
      setStatus("Invalid code.");
      return;
    }

    const alreadyEnrolled = enrollments.some(e => e.courseId === course.id && e.studentId === user.uid);
    if (alreadyEnrolled) {
      setStatus("Already enrolled.");
      return;
    }

    try {
      setIsJoining(true);
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'enrollments'), {
        studentId: user.uid,
        studentName: profileDisplayName(profile),
        courseId: course.id,
        joinedAt: new Date().toISOString()
      });
      setStatus('');
      setCode('');
    } catch (err) {
      setStatus("Error joining.");
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <form onSubmit={handleJoin} className="flex flex-col items-end gap-1 w-full md:w-auto">
      <div className="flex gap-2 w-full">
        <input type="text" placeholder="Invite Code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={15}
          className="px-3 py-2 border rounded font-mono text-sm w-full md:w-32 uppercase focus:outline-none" style={{ borderColor: theme.paperLine }} />
        <button type="submit" disabled={isJoining || !code.trim()} className="px-4 py-2 rounded text-white text-sm font-semibold whitespace-nowrap disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
          {isJoining ? 'Joining…' : 'Join'}
        </button>
      </div>
      {status && <span role="status" aria-live="polite" className="text-xs text-red-600">{status}</span>}
    </form>
  );
}

// --- The core student tracker (adapted from ALEKS HTML) ---
function StudentCourseTracker({ user, profile, course, manualCompletions, usage, progressReports, onBack, onLogout }) {
  const [search, setSearch] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [pendingTopicId, setPendingTopicId] = useState('');
  const courseTopics = getTopics(course);
  const latestReport = latestReportFor(progressReports, course.id, user.uid);
  const myManualCompletions = manualCompletionsFor(manualCompletions, course.id, user.uid, courseTopics);
  const stats = combinedProgress(latestReport, myManualCompletions, courseTopics);
  const topicStatus = new Map<string, string>((latestReport?.topicStatuses || []).map(item => [String(item.topicId), String(item.status)]));
  const manualTopicIds = new Set(myManualCompletions.map(record => record.topicId));
  const myUsage = usageForStudent(usage, user.uid);
  const thisWeekVisits = Number(myUsage.find(record => record.weekStart === weekStartFor())?.visitCount) || 0;
  const totalVisits = myUsage.reduce((sum, record) => sum + (Number(record.visitCount) || 0), 0);

  // Group topics
  const groups = useMemo(() => {
    const g = {};
    const order = [];
    courseTopics.forEach(t => {
      if (!g[t.group]) { g[t.group] = []; order.push(t.group); }
      g[t.group].push(t);
    });
    return order.map(group => ({ group, items: g[group] }));
  }, [course.topics]);

  const total = stats.total || courseTopics.length;
  const done = stats.completed;
  const pct = stats.pct;
  
  // Donut SVG maths
  const r = 50, cx = 60, cy = 60, circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);

  const readyTopics = reportTopicsByStatus(latestReport, 'readyToLearn', courseTopics).filter(topic => !manualTopicIds.has(topic.id));
  const assistantStatuses = courseTopics.map(topic => ({
    topicId: topic.id,
    status: manualTopicIds.has(topic.id) && !['mastered', 'learned'].includes(topicStatus.get(topic.id))
      ? 'manuallyCompleted'
      : (topicStatus.get(topic.id) || 'remaining')
  }));

  const toggleManualCompletion = async (topicId) => {
    if (pendingTopicId) return;
    setPendingTopicId(topicId);
    try {
      const existing = myManualCompletions.find(record => record.topicId === topicId);
      if (existing) {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'mastery', existing.id));
      } else {
        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'mastery'), {
          studentId: user.uid,
          studentName: profileDisplayName(profile),
          courseId: course.id,
          topicId,
          date: new Date().toISOString(),
          source: 'manual'
        });
      }
    } catch (error) {
      console.error('Could not update the topic:', error);
      setSyncResult(`Error: ${error.message || 'The topic could not be updated.'}`);
    } finally {
      setPendingTopicId('');
    }
  };

  const handleAleksReportUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const validName = /^ALEKS_Pie_Report(?:\s*\(\d+\))?\.pdf$/i.test(file.name);
    const validType = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!validName || !validType || file.size > 10 * 1024 * 1024) {
      setSyncResult('Error: upload an ALEKS_Pie_Report.pdf file smaller than 10 MB.');
      e.target.value = null;
      return;
    }

    setIsAnalyzing(true);
    setSyncResult('Reading and analyzing your ALEKS Pie Report...');
    
    try {
      const text = await extractTextFromPdf(file);
      if (!/ALEKS\s+Pie\s+Report/i.test(text)) throw new Error('This PDF is not an ALEKS Pie Report.');
      const result = await analyzeAleksReportWithOpenAI(text, courseTopics);
      const uploadedAt = new Date().toISOString();
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'progressReports'), {
        studentId: user.uid,
        studentName: profileDisplayName(profile),
        courseId: course.id,
        reportDate: result.reportDate || '',
        reportedClassName: result.className || '',
        summary: result.summary,
        topicStatuses: result.topicStatuses || [],
        unmatchedTopicCount: (result.unmatchedTopics || []).length,
        uploadedAt,
        source: 'ALEKS Pie Report'
      });
      const summary = result.summary || {};
      setSyncResult(`Report synced: ${summary.mastered || 0} mastered, ${summary.learned || 0} learned, and ${summary.readyToLearn || 0} ready to learn.`);
    } catch (err) {
      console.error(err);
      setSyncResult(`Error: ${err.message || 'The ALEKS Pie Report could not be analyzed.'}`);
    } finally {
      setIsAnalyzing(false);
      e.target.value = null;
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 pb-20 bg-[#F6F3EA] rounded min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <button onClick={onBack} className="flex items-center text-sm font-medium hover:underline" style={{ color: theme.inkSoft }}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
        </button>
        <button onClick={onLogout} className="flex items-center gap-2 text-sm font-medium hover:underline text-red-800">
          <LogOut className="w-4 h-4" /> Log out
        </button>
      </div>

      <div className="font-mono text-[11px] uppercase tracking-widest mb-1" style={{ color: theme.gold }}>{course.code} &middot; Student Usage</div>
      <h1 className="text-3xl font-serif font-bold mb-1" style={{ color: theme.ink }}>{course.name}</h1>
      <div className="text-[13.5px] mb-6" style={{ color: theme.inkSoft }}>Your weekly visits and latest ALEKS Pie Report are shared live with your instructor.</div>

      <CourseAssistant role="student" course={course} topicStatuses={assistantStatuses} />

      <section className="grid gap-3 sm:grid-cols-3 mb-6" aria-label="Student site usage">
        <div className="bg-white border rounded-lg p-4" style={{ borderColor: theme.paperLine }}>
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: theme.inkSoft }}>Visits this week</div>
          <div className="text-2xl font-serif font-bold">{thisWeekVisits}</div>
          <div className="text-xs mt-1" style={{ color: theme.inkSoft }}>{weekLabel(weekStartFor())}</div>
        </div>
        <div className="bg-white border rounded-lg p-4" style={{ borderColor: theme.paperLine }}>
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: theme.inkSoft }}>Total site visits</div>
          <div className="text-2xl font-serif font-bold">{totalVisits}</div>
          <div className="text-xs mt-1" style={{ color: theme.inkSoft }}>{myUsage.length} week{myUsage.length === 1 ? '' : 's'} recorded</div>
        </div>
        <div className="bg-white border rounded-lg p-4" style={{ borderColor: theme.paperLine }}>
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: theme.inkSoft }}>Last ALEKS sync</div>
          <div className="text-base font-serif font-bold mt-1">{latestReport?.reportDate || 'Not uploaded'}</div>
          <div className="text-xs mt-1" style={{ color: theme.inkSoft }}>{latestReport?.uploadedAt ? new Date(latestReport.uploadedAt).toLocaleString() : 'Upload your report below'}</div>
        </div>
      </section>

      {/* Hero Stats */}
      <div className="bg-white border rounded-lg p-5 md:p-6 mb-6 flex flex-col md:flex-row gap-6 items-center" style={{ borderColor: theme.paperLine }}>
        <div className="flex flex-col items-center gap-1 shrink-0 w-48">
          <svg viewBox="0 0 120 120" width="120" height="120" className="rotate-[-90deg]">
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="#EDEAE0" strokeWidth="12" />
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="#3F7D58" strokeWidth="12"
              strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
              className="transition-all duration-700 ease-out" />
          </svg>
          <div className="absolute font-serif font-bold text-xl mt-[45px]">{pct}%</div>
          <div className="font-mono text-[10.5px] mt-2" style={{ color: theme.inkSoft }}>CURRENT PROGRESS</div>
        </div>
        
        <div className="flex-1 w-full border-t md:border-t-0 md:border-l pt-4 md:pt-0 md:pl-6" style={{ borderColor: theme.paperLine }}>
          <h2 className="font-serif text-[17px] mb-3">Current progress summary</h2>
          {!latestReport && myManualCompletions.length === 0 ? (
            <div className="text-[13px]" style={{ color: theme.inkSoft }}>Upload ALEKS_Pie_Report.pdf or mark topics complete below.</div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                { label: 'Mastered', value: stats.mastered, color: theme.mastered },
                { label: 'Learned', value: stats.learned, color: '#315E8A' },
                { label: 'Manually complete', value: stats.manualCompleted, color: '#65458A' },
                { label: 'Ready to learn', value: stats.readyToLearn, color: '#8A641F' },
                { label: 'Remaining', value: stats.remaining, color: theme.remaining }
              ].map(({ label, value, color }) => (
                <div key={label} className="border rounded p-3" style={{ borderColor: theme.paperLine }}>
                  <div className="text-xl font-serif font-bold" style={{ color }}>{value}</div>
                  <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: theme.inkSoft }}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border rounded-lg p-5 mb-6 flex flex-col sm:flex-row items-center justify-between gap-4" style={{ borderColor: theme.paperLine }}>
        <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-blue-50 text-blue-600 mt-1">
                <FileText className="w-5 h-5" />
            </div>
            <div>
                <h3 className="font-serif font-bold text-sm" style={{ color: theme.ink }}>Sync ALEKS Pie Report</h3>
                <p className="text-xs" style={{ color: theme.inkSoft }}>Upload only an ALEKS_Pie_Report.pdf. ChatGPT extracts your Learned, Mastered, and Ready To Learn status.</p>
                {syncResult && (
                    <p className={`text-xs mt-2 font-medium ${syncResult.includes('Error') ? 'text-red-600' : 'text-blue-600'}`}>{syncResult}</p>
                )}
            </div>
        </div>
        <div className="shrink-0 relative w-full sm:w-auto">
            <input type="file" accept="application/pdf,.pdf" aria-label="Upload ALEKS Pie Report PDF" onChange={handleAleksReportUpload} disabled={isAnalyzing} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10" />
            <button disabled={isAnalyzing} className="w-full sm:w-auto px-4 py-2 rounded text-white text-sm font-semibold flex items-center justify-center transition-opacity disabled:opacity-50" style={{ backgroundColor: theme.ink }}>
                {isAnalyzing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                {isAnalyzing ? 'Analyzing PDF...' : 'Upload ALEKS PDF'}
            </button>
        </div>
      </div>

      {/* Suggestion Box */}
      <div className="border rounded-lg p-5 mb-6" style={{ backgroundColor: theme.masteredBg, borderColor: '#BFDCC5' }}>
        <div className="flex justify-between items-baseline flex-wrap gap-2 mb-2">
          <h2 className="font-serif text-[15px] m-0" style={{ color: theme.mastered }}>Ready to learn next</h2>
          <span className="font-mono text-[11.5px]" style={{ color: theme.inkSoft }}>{done} of {total} progressed</span>
        </div>
        {!latestReport ? (
          <div className="text-[13px]" style={{ color: theme.inkSoft }}>Upload your ALEKS Pie Report to receive current ALEKS recommendations. You can still mark topics complete below.</div>
        ) : readyTopics.length === 0 ? (
          <div className="text-[13px] font-medium" style={{ color: theme.mastered }}>No matched Ready To Learn topics were found in the latest report.</div>
        ) : (
          <div>
            <div className="text-[13px] mb-2">ALEKS identifies {stats.readyToLearn} topic(s) as ready. Matched course topics:</div>
            <ul className="list-disc pl-5 text-[13px] space-y-1">
              {readyTopics.slice(0, 5).map(t => <li key={t.id}>{t.title}</li>)}
            </ul>
            {readyTopics.length > 5 && <div className="text-xs mt-2" style={{ color: theme.inkSoft }}>+ {readyTopics.length - 5} more below.</div>}
          </div>
        )}
      </div>

      {/* Search */}
      <p className="text-xs mb-3" style={{ color: theme.inkSoft }}>Select a Remaining or Ready to Learn topic to mark it manually complete. Select it again to undo.</p>
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-3.5" style={{ color: theme.inkSoft }} />
        <input type="text" placeholder="Search topics..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 border rounded bg-white text-[13px] focus:outline-none"
          style={{ borderColor: theme.paperLine, color: theme.ink }} />
      </div>

      {/* Topic List */}
      <div className="space-y-6">
        {groups.map(({ group, items }) => {
          const q = search.toLowerCase().trim();
          const filtered = q ? items.filter(t => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)) : items;
          if (filtered.length === 0) return null;
          
          const groupDone = items.filter(t => {
            const status = topicStatus.get(t.id);
            return status === 'mastered' || status === 'learned' || manualTopicIds.has(t.id);
          }).length;
          
          return (
            <div key={group}>
              <div className="flex justify-between items-baseline font-mono text-[11px] uppercase tracking-wider border-b pb-1 mb-2" style={{ color: theme.gold, borderColor: theme.paperLine }}>
                {group} <span className="normal-case tracking-normal" style={{ color: theme.inkSoft }}>{groupDone}/{items.length} complete</span>
              </div>
              <div className="space-y-1">
                {filtered.map(t => {
                  const aleksStatus = topicStatus.get(t.id) || 'remaining';
                  const isAleksComplete = aleksStatus === 'mastered' || aleksStatus === 'learned';
                  const isManual = manualTopicIds.has(t.id) && !isAleksComplete;
                  const status = isManual ? 'manual' : aleksStatus;
                  const statusStyle = status === 'mastered'
                    ? 'bg-[#E4EFE6] text-[#3F7D58] border-[#BFDCC5]'
                    : status === 'learned'
                      ? 'bg-[#E7EFF8] text-[#315D85] border-[#C5D8EC]'
                      : status === 'manual'
                        ? 'bg-[#EEE8F7] text-[#65458A] border-[#D6C5E8]'
                      : status === 'readyToLearn'
                        ? 'bg-[#F7EED4] text-[#866919] border-[#E8D59C]'
                        : 'bg-[#EDEAE0] text-[#8B8470] border-transparent';
                  const statusLabel = status === 'readyToLearn' ? 'ready to learn' : status === 'manual' ? '✓ manually complete' : status;
                  return (
                    <button key={t.id} type="button" onClick={() => toggleManualCompletion(t.id)} disabled={Boolean(pendingTopicId) || isAleksComplete}
                      className="w-full text-left grid grid-cols-[40px_1fr_100px] md:grid-cols-[40px_1fr_150px] gap-2 items-center p-2 border-b text-[13px] hover:bg-[#FBFAF5] transition-colors disabled:cursor-default disabled:opacity-80"
                      style={{ borderColor: '#EFEBDF' }}>
                      <span className="font-mono text-xs" style={{ color: theme.inkSoft }}>{t.id}</span>
                      <span className="pr-2">{t.title}</span>
                      <span className="flex justify-end">
                        <span className={`font-mono text-[10.5px] font-medium px-2.5 py-0.5 rounded-full border whitespace-nowrap select-none ${statusStyle}`}>
                          {pendingTopicId === t.id ? 'saving…' : status === 'mastered' ? '✓ mastered' : statusLabel}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
