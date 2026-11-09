import {useState} from 'react';
import {ArrowLeft, Eye, EyeOff, Loader2} from 'lucide-react';
import {api, useWorkspace} from '../lib/workspace';
import {Logo} from './UI';

type Props={onBack:()=>void};

export default function ResetPassword({onBack}:Props) {
  const [token]=useState(()=>new URLSearchParams(location.search).get('token')||'');
  const [linkError]=useState(()=>new URLSearchParams(location.search).has('error'));
  const [password,setPassword]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [visible,setVisible]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const notify=useWorkspace(store=>store.notify);
  const validLink=Boolean(token)&&!linkError;

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(busy||!validLink)return;
    if(password.length<8||password.length>128){setError('Use a password between 8 and 128 characters.');return;}
    if(password!==confirmation){setError('The passwords do not match.');return;}
    setBusy(true);setError('');
    try {
      await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify({newPassword:password,token})});
      setPassword('');setConfirmation('');
      notify('Your password has been changed. Sign in with your new password.');
      onBack();
    } catch(caught) {
      const message=caught instanceof Error?caught.message:'Your password could not be reset. Please try again.';
      setError(/expired|invalid.*token|token.*invalid|token.*not.*found|invalid.*reset/i.test(message)?'This reset link is invalid or has expired. Go back to login and request a new reset email.':message);
    } finally {setBusy(false);}
  };

  return <div className="auth-page">
    <button className="back-link" disabled={busy} onClick={onBack}><ArrowLeft size={15}/>Back to login</button>
    <div className="auth-card">
      <Logo/>
      <h2>Choose a new password</h2>
      {validLink?<>
        <p className="muted">Set a new password for your monogram account.</p>
        <form onSubmit={event=>void submit(event)}>
          <label>New password
            <input autoFocus type={visible?'text':'password'} autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event=>setPassword(event.target.value)} aria-describedby="reset-password-help"/>
            <small id="reset-password-help" className="muted">Use at least 8 characters.</small>
          </label>
          <label>Confirm new password
            <input type={visible?'text':'password'} autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={confirmation} onChange={event=>setConfirmation(event.target.value)}/>
          </label>
          <button type="button" className="text-btn tool-group" disabled={busy} aria-pressed={visible} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={15}/>:<Eye size={15}/>} {visible?'Hide passwords':'Show passwords'}</button>
          {error&&<p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="primary full-width" disabled={busy}>{busy?<><Loader2 size={15} className="spin"/>Changing password…</>:'Change password'}</button>
        </form>
      </>:<>
        <p className="form-error" role="alert">{linkError?'This reset link is invalid or has expired.':'This reset link is missing its token.'} Go back to login and request a new reset email.</p>
        <button className="primary full-width" onClick={onBack}>Back to login</button>
      </>}
    </div>
  </div>;
}
