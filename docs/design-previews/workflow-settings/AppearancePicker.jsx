import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { IconPalette, IconCheck, IconX, IconSun, IconMoon } from '@tabler/icons-react';
import { themes, themeById } from './themes.mjs';

export default function AppearancePicker({ value, onChange }) {
  const current = themeById(value.preset);
  const update = (field, next) => onChange(previous => ({ ...previous, [field]: next }));
  return <Popover.Root>
    <Popover.Trigger asChild><button className="appearance-trigger" aria-label="外观设置"><IconPalette size={17}/><span>外观</span><span className="current-material">{current.name}</span></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="appearance-popover" align="end" sideOffset={12} collisionPadding={14} aria-label="外观设置">
      <header className="appearance-heading"><div><div className="catalog-eyebrow">THE THEME COLLECTION</div><h2>找到你的工作氛围</h2><p>7 套完整外观，细节各有性格。</p></div><Popover.Close asChild><button className="icon-button" aria-label="关闭外观设置"><IconX size={18}/></button></Popover.Close></header>
      <div className="theme-collection" role="radiogroup" aria-label="界面主题">
        {['light', 'dark'].map(mode => <div className="theme-group" key={mode}><div className="theme-group-title">{mode === 'light' ? <IconSun size={14}/> : <IconMoon size={14}/>}<span>{mode === 'light' ? '明亮' : '深色'}</span><small>{themes.filter(theme => theme.mode === mode).length}</small></div><div className="skin-options">
          {themes.filter(theme => theme.mode === mode).map(theme => <button key={theme.id} id={`theme-${theme.id}`} className={`skin-option ${value.preset === theme.id ? 'chosen' : ''}`} role="radio" aria-checked={value.preset === theme.id} aria-label={`${theme.name} · ${theme.caption}`} tabIndex={value.preset === theme.id ? 0 : -1} onClick={() => update('preset', theme.id)} onKeyDown={event => {
            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
              event.preventDefault(); const index = themes.findIndex(item => item.id === theme.id);
              const next = event.key === 'Home' ? themes[0] : event.key === 'End' ? themes.at(-1) : themes[(index + (['ArrowRight','ArrowDown'].includes(event.key) ? 1 : themes.length - 1)) % themes.length];
              update('preset', next.id); document.getElementById(`theme-${next.id}`)?.focus();
            }
          }}>
            <span className="theme-sample" data-preset={theme.id} data-material={theme.material} aria-hidden="true"><span className="mini-window"><span className="mini-sidebar"><i/><i/><i/></span><span className="mini-content"><b/><i/><span className="mini-input"/><span className="mini-action"/></span><span className="mini-menu"><i/><i/></span></span></span>
            <span className="skin-option-title">{theme.name}{value.preset === theme.id && <IconCheck size={14}/>}</span><small>{theme.caption}</small>
          </button>)}
        </div></div>)}
      </div>
      <div className="appearance-preferences">
        <Preference title="氛围背景" description="使用这套主题搭配的背景" checked={value.background} onChange={next => update('background', next)}/>
        <Preference title="细腻动效" description="轻盈的切换与操作反馈" checked={value.motion} onChange={next => update('motion', next)}/>
        <Preference title="降低透明度" description={current.material === 'glass' ? '保留配色，使用实色表面' : '在冰川与黑曜中可用'} checked={value.opaque} disabled={current.material !== 'glass'} onChange={next => update('opaque', next)}/>
      </div><p className="appearance-note">自动记住外观 · 切换保留草稿 · 尊重系统减少动效设置</p>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
function Preference({ title, description, checked, disabled = false, onChange }) {
  return <label className="appearance-preference"><span><strong>{title}</strong><small>{description}</small></span><input type="checkbox" role="switch" className="switch" aria-label={title} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/></label>;
}
