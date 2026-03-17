import { useEffect, useState } from 'react'
import { setupApi } from '../lib/api'
import { DialogShell } from '../components/Dialog'
import { Field, RecipeSection } from './SettingsPage'

export default function RecipePage() {
  const [vaultGitUrl, setVaultGitUrl] = useState('')
  const [vaultGitDraft, setVaultGitDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const loadSettings = async () => {
    setLoadingSettings(true)
    try {
      const keys = await setupApi.getKeys()
      setVaultGitUrl(keys.vault_git_url ?? '')
      setVaultGitDraft(keys.vault_git_url ?? '')
      setSettingsError(null)
    } catch (err: any) {
      setSettingsError(err.message ?? 'Failed to load recipe settings')
    } finally {
      setLoadingSettings(false)
    }
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  const openSettings = () => {
    setVaultGitDraft(vaultGitUrl)
    setSettingsError(null)
    setSettingsOpen(true)
  }

  const saveSettings = async () => {
    setSavingSettings(true)
    setSettingsError(null)
    try {
      const nextUrl = vaultGitDraft.trim()
      await setupApi.saveKeys({ vaultGitUrl: nextUrl })
      setVaultGitUrl(nextUrl)
      setSettingsOpen(false)
    } catch (err: any) {
      setSettingsError(err.message ?? 'Failed to save recipe settings')
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] px-6 py-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      <div className="max-w-[900px] mx-auto">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">shared skills</div>
            <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-2">recipe</div>
          </div>
          <button
            type="button"
            onClick={openSettings}
            className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] px-3 py-2 text-[16px] leading-none hover:bg-[#243548]"
            title="recipe settings"
          >
            ⚙
          </button>
        </div>

        {!loadingSettings && settingsError && !settingsOpen && (
          <div className="border-[2px] border-[#c0392b] bg-[#2a1116] px-3 py-2 text-[11px] text-[#f3b0b0] mb-4">
            {settingsError}
          </div>
        )}

        <RecipeSection standalone vaultGitUrl={vaultGitUrl} />
      </div>

      {settingsOpen && (
        <DialogShell
          title="recipe settings"
          tone="info"
          widthClassName="max-w-[520px]"
          onClose={() => setSettingsOpen(false)}
          footer={(
            <div className="flex items-center justify-end gap-2 px-5 py-3">
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="border-[2px] border-black bg-[#1e1a20] text-[#9a8888] px-3 py-1.5 text-[11px] uppercase hover:text-[#e7dfd3]"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={saveSettings}
                disabled={savingSettings}
                className="border-[3px] border-black bg-[#c0392b] text-black px-4 py-1.5 text-[11px] uppercase hover:bg-[#e04050] disabled:opacity-40"
              >
                {savingSettings ? 'saving...' : 'save'}
              </button>
            </div>
          )}
        >
          <Field
            label="vault git url"
            value={vaultGitDraft}
            onChange={setVaultGitDraft}
            placeholder="git@github.com:org/vault.git"
            hint="Recipe imports now read skills from the value path inside this vault git source."
            mono
          />

          {settingsError && (
            <div className="border-[2px] border-[#c0392b] bg-[#2a1116] px-3 py-2 text-[11px] text-[#f3b0b0] mb-3">
              {settingsError}
            </div>
          )}
        </DialogShell>
      )}
    </div>
  )
}
