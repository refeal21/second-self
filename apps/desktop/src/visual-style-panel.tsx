import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type {
  TemplateStyleInspection,
  VisualStyleProfile,
  VisualStyleState,
} from '../../worker/src/visual-style.js';
import './visual-style-panel.css';

export interface VisualStylePanelProps {
  style: VisualStyleState;
  busy: boolean;
  inspectTemplate: (input: {
    fileName: string;
    contentsBase64: string;
  }) => Promise<TemplateStyleInspection>;
  onSave: (
    profile: VisualStyleProfile,
    templateBase64?: string,
  ) => Promise<VisualStyleState>;
  onDirtyChange?: (dirty: boolean) => void;
  onStyleChange?: (style: VisualStyleState) => void;
}

interface PendingTemplate {
  base64: string;
  inspection: TemplateStyleInspection;
  template: NonNullable<VisualStyleProfile['template']>;
}

const MAX_PPTX_BYTES = 50 * 1024 * 1024;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_PROFILE: VisualStyleProfile = {
  primaryColor: '#333333',
  backgroundColor: '#FFFFFF',
  textColor: '#222222',
  accentColors: ['#666666'],
  instructions: '',
  template: null,
};

function copyProfile(profile: VisualStyleProfile | null): VisualStyleProfile {
  const source = profile ?? DEFAULT_PROFILE;
  return {
    ...source,
    accentColors: [...source.accentColors],
    template: source.template ? { ...source.template } : null,
  };
}

function profileKey(profile: VisualStyleProfile): string {
  return JSON.stringify({
    primaryColor: profile.primaryColor,
    backgroundColor: profile.backgroundColor,
    textColor: profile.textColor,
    accentColors: profile.accentColors,
    instructions: profile.instructions,
    template: profile.template ? {
      fileName: profile.template.fileName,
      sha256: profile.template.sha256,
      relativePath: profile.template.relativePath,
    } : null,
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isNeutralSuggestion(color: string): boolean {
  if (!HEX_COLOR.test(color)) return true;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  return (red >= 245 && green >= 245 && blue >= 245) || spread <= 12;
}

function suggestedColors(inspection: TemplateStyleInspection | null) {
  const colors = inspection?.colors.filter(({ color }) => HEX_COLOR.test(color)) ?? [];
  const primary = [...colors]
    .filter(({ color }) => !isNeutralSuggestion(color))
    .sort((left, right) => right.count - left.count)[0]?.color ?? null;
  return { colors, primary };
}

function validateProfile(profile: VisualStyleProfile): string | null {
  const roles: Array<[string, string]> = [
    ['主色', profile.primaryColor],
    ['背景色', profile.backgroundColor],
    ['文字色', profile.textColor],
  ];
  for (const [label, color] of roles) {
    if (!HEX_COLOR.test(color)) return `${label}必须使用 #RRGGBB 格式。`;
  }
  if (profile.accentColors.length > 8) return '强调色最多填写 8 个。';
  if (profile.accentColors.some((color) => !HEX_COLOR.test(color))) {
    return '强调色必须使用 #RRGGBB 格式，并用逗号分隔。';
  }
  return null;
}

export function VisualStylePanel({
  style,
  busy,
  inspectTemplate,
  onSave,
  onDirtyChange,
  onStyleChange,
}: VisualStylePanelProps) {
  const [currentStyle, setCurrentStyle] = useState(style);
  const [draft, setDraft] = useState(() => copyProfile(style.profile));
  const [accentInput, setAccentInput] = useState(() => copyProfile(style.profile).accentColors.join(', '));
  const [pendingTemplate, setPendingTemplate] = useState<PendingTemplate | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inspectionIdRef = useRef(0);
  const lastStyleKeyRef = useRef('');

  const incomingStyleKey = `${style.revision}:${style.locked}:${profileKey(copyProfile(style.profile))}`;
  useEffect(() => {
    if (lastStyleKeyRef.current === incomingStyleKey) return;
    lastStyleKeyRef.current = incomingStyleKey;
    const nextDraft = copyProfile(style.profile);
    setCurrentStyle(style);
    setDraft(nextDraft);
    setAccentInput(nextDraft.accentColors.join(', '));
    setPendingTemplate(null);
    setError(null);
  }, [incomingStyleKey, style]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inspectionIdRef.current += 1;
    };
  }, []);

  const normalizedAccents = useMemo(
    () => accentInput.split(',').map((color) => color.trim()).filter(Boolean),
    [accentInput],
  );
  const draftForSave = useMemo<VisualStyleProfile>(() => ({
    ...draft,
    accentColors: normalizedAccents,
    instructions: draft.instructions,
    template: pendingTemplate?.template ?? draft.template,
  }), [draft, normalizedAccents, pendingTemplate]);
  const baseline = copyProfile(currentStyle.profile);
  const dirty = profileKey(draftForSave) !== profileKey(baseline);

  const dirtyForNavigation = dirty || inspecting || saving;
  useEffect(() => {
    onDirtyChange?.(dirtyForNavigation);
  }, [dirtyForNavigation, onDirtyChange]);

  const disabled = busy || inspecting || saving;
  const editDisabled = currentStyle.locked || disabled;
  const saveAvailable = dirty || currentStyle.profile === null;
  const suggestions = suggestedColors(pendingTemplate?.inspection ?? null);
  const currentProfile = copyProfile(currentStyle.profile);

  const updateDraft = (patch: Partial<VisualStyleProfile>) => {
    if (editDisabled) return;
    setDraft((previous) => ({ ...previous, ...patch }));
    setError(null);
  };

  const handleTemplate = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || editDisabled) return;
    setError(null);
    if (!file.name.toLowerCase().endsWith('.pptx')) {
      setError('请选择 .pptx 文件。');
      return;
    }
    if (file.size > MAX_PPTX_BYTES) {
      setError('PPTX 不能超过 50 MiB。');
      return;
    }

    const inspectionId = ++inspectionIdRef.current;
    setInspecting(true);
    try {
      const contents = new Uint8Array(await file.arrayBuffer());
      const contentsBase64 = bytesToBase64(contents);
      const [inspection, hashBuffer] = await Promise.all([
        inspectTemplate({ fileName: file.name, contentsBase64 }),
        crypto.subtle.digest('SHA-256', contents),
      ]);
      if (!mountedRef.current || inspectionIdRef.current !== inspectionId) return;
      const sha256 = bytesToHex(new Uint8Array(hashBuffer));
      setPendingTemplate({
        base64: contentsBase64,
        inspection,
        template: {
          fileName: file.name,
          sha256,
          relativePath: `visuals/style-templates/${sha256}.pptx`,
        },
      });
    } catch (cause) {
      if (!mountedRef.current || inspectionIdRef.current !== inspectionId) return;
      setError(errorMessage(cause, '无法检查这个 PPTX，请换一个文件重试。'));
    } finally {
      if (mountedRef.current && inspectionIdRef.current === inspectionId) setInspecting(false);
    }
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (editDisabled || !saveAvailable) return;
    const validationError = validateProfile(draftForSave);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const savedStyle = await onSave(draftForSave, pendingTemplate?.base64);
      if (!mountedRef.current) return;
      const savedDraft = copyProfile(savedStyle.profile);
      setCurrentStyle(savedStyle);
      setDraft(savedDraft);
      setAccentInput(savedDraft.accentColors.join(', '));
      setPendingTemplate(null);
      onStyleChange?.(savedStyle);
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause, '保存配色失败，请重试。'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <details
      className="visual-style-panel"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>项目配色与模板参考</span>
        <span className="visual-style-panel__summary-state">
          {currentStyle.locked ? '已锁定' : currentStyle.profile ? `版本 ${currentStyle.revision}` : '未保存'}
        </span>
      </summary>

      <form className="visual-style-panel__body" onSubmit={handleSave}>
        <section className="visual-style-panel__current" aria-label="当前项目配色">
          <div>
            <h3>当前配色</h3>
            <p>{currentStyle.profile ? '已保存到项目' : '中性默认值，尚未保存'}</p>
          </div>
          <div className="visual-style-panel__palette" aria-label="当前配色色板">
            {[currentProfile.primaryColor, currentProfile.backgroundColor, currentProfile.textColor,
              ...currentProfile.accentColors].map((color, index) => (
              <span
                className="visual-style-panel__current-swatch"
                key={`${color}-${index}`}
                style={{ backgroundColor: color }}
                title={color}
                aria-label={color}
              />
            ))}
          </div>
        </section>

        {currentStyle.locked && (
          <p className="visual-style-panel__lock" role="status">
            首次视觉稿获批后配色会永久锁定；重新打开视觉稿也不会解锁。
          </p>
        )}

        <section className="visual-style-panel__template" aria-labelledby="visual-template-heading">
          <div>
            <h3 id="visual-template-heading">PPTX 模板配色参考</h3>
            <p className="visual-style-panel__notice">仅提取配色；尚未将图片插入模板</p>
          </div>
          <label className="visual-style-panel__file">
            <span>{inspecting ? '正在检查模板…' : '选择 PPTX 模板'}</span>
            <input
              aria-label="选择 PPTX 模板"
              type="file"
              accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              disabled={editDisabled}
              onChange={handleTemplate}
            />
          </label>
          {(pendingTemplate || draft.template) && (
            <p className="visual-style-panel__template-name">
              {pendingTemplate ? '待确认参考' : '已保存参考'}：
              <strong>{pendingTemplate?.template.fileName ?? draft.template?.fileName}</strong>
            </p>
          )}
        </section>

        {pendingTemplate && (
          <section className="visual-style-panel__suggestions" aria-label="模板配色建议">
            <p>
              检测到 {pendingTemplate.inspection.slideCount} 页；以下颜色只是建议，需要确认后才会保存。
            </p>
            {suggestions.primary && (
              <p className="visual-style-panel__recommendation">
                建议主色：<strong>{suggestions.primary}</strong>（非白色、非灰色中出现次数最多）
              </p>
            )}
            <div className="visual-style-panel__swatches">
              {suggestions.colors.map(({ color, count }) => (
                <button
                  type="button"
                  className={color === suggestions.primary ? 'is-primary-suggestion' : undefined}
                  key={color}
                  disabled={editDisabled}
                  aria-label={`使用 ${color} 作为主色`}
                  title={`${color} · ${count} 次`}
                  onClick={() => updateDraft({ primaryColor: color })}
                >
                  <span style={{ backgroundColor: color }} />
                  <span>{color}</span>
                  <small>{count} 次</small>
                </button>
              ))}
            </div>
            {pendingTemplate.inspection.warnings.length > 0 && (
              <ul className="visual-style-panel__warnings" aria-label="模板检查提示">
                {pendingTemplate.inspection.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        <fieldset className="visual-style-panel__roles" disabled={editDisabled}>
          <legend>角色配色</legend>
          <label>
            <span>主色</span>
            <input
              aria-label="主色"
              value={draft.primaryColor}
              spellCheck={false}
              onChange={(event) => updateDraft({ primaryColor: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>背景色</span>
            <input
              aria-label="背景色"
              value={draft.backgroundColor}
              spellCheck={false}
              onChange={(event) => updateDraft({ backgroundColor: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>文字色</span>
            <input
              aria-label="文字色"
              value={draft.textColor}
              spellCheck={false}
              onChange={(event) => updateDraft({ textColor: event.currentTarget.value })}
            />
          </label>
          <label className="visual-style-panel__accent-field">
            <span>强调色（逗号分隔）</span>
            <input
              aria-label="强调色（逗号分隔）"
              value={accentInput}
              spellCheck={false}
              onChange={(event) => {
                if (editDisabled) return;
                setAccentInput(event.currentTarget.value);
                setError(null);
              }}
            />
          </label>
        </fieldset>

        <label className="visual-style-panel__instructions">
          <span>视觉说明</span>
          <textarea
            aria-label="视觉说明"
            rows={3}
            maxLength={4_000}
            value={draft.instructions}
            disabled={editDisabled}
            placeholder="例如：低饱和、留白充足；这些说明不会改写已批准的事实。"
            onChange={(event) => updateDraft({ instructions: event.currentTarget.value })}
          />
        </label>

        {error && <p className="visual-style-panel__error" role="alert">{error}</p>}

        <footer className="visual-style-panel__footer">
          <p>{dirty ? '有未保存的配色更改' : currentStyle.profile ? '当前配色已保存' : '默认配色尚未保存'}</p>
          <button type="submit" disabled={editDisabled || !saveAvailable}>
            {currentStyle.locked ? '配色已锁定' : saving ? '正在保存…' : '确认保存配色'}
          </button>
        </footer>
      </form>
    </details>
  );
}
