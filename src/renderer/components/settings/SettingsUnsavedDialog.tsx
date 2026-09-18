import React, { useEffect, useId, useRef } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface Props { open: boolean; busy: boolean; onContinue: () => void; onDiscard: () => void; onSave: () => void }
export default function SettingsUnsavedDialog({ open, busy, onContinue, onDiscard, onSave }: Props): React.ReactElement {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    continueButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  const t = (key: string) => i18nService.t(key);
  return <Modal isOpen={open} onClose={onContinue} onEscape={onContinue}
    overlayClassName="fixed inset-0 z-[70] modal-backdrop flex items-center justify-center p-4"
    className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-modal">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) { event.preventDefault(); return; }
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <h3 id={`${id}-title`} className="text-base font-semibold">{t('settingsUnsavedTitle')}</h3>
      <p id={`${id}-description`} className="mt-3 text-sm leading-6 text-secondary">{t('settingsUnsavedDescription')}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2 text-xs">
        <button ref={continueButton} type="button" onClick={onContinue} className="rounded-lg border border-border px-3 py-2 hover:bg-surface-raised">{t('settingsContinueEditing')}</button>
        <button type="button" disabled={busy} onClick={onDiscard} className="rounded-lg border border-border px-3 py-2 hover:bg-surface-raised disabled:opacity-50">{t('settingsDiscardDraft')}</button>
        <button type="button" disabled={busy} onClick={onSave} className="rounded-lg bg-primary px-3 py-2 text-white hover:bg-primary-hover disabled:opacity-50">{t('settingsSaveDraft')}</button>
      </div>
    </div>
  </Modal>;
}
