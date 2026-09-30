import React, { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { IconLayoutGrid, IconX, IconArrowRight, IconChevronDown, IconCheck, IconCircleCheck, IconAlertCircle, IconLoader2, IconBell, IconPalette } from '@tabler/icons-react';
import { themes } from './themes.mjs';

export default function ComponentLab({ theme, appearance, onAppearanceChange }) {
  const [open, setOpen] = useState(false), [enabled, setEnabled] = useState(true), [failure, setFailure] = useState(false), [status, setStatus] = useState('idle'), [choice, setChoice] = useState('仅完成时'), [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const changeOpen = next => { setOpen(next); if (!next) { clearTimeout(timer.current); setStatus('idle'); setMenuOpen(false); } };
  const save = () => { setStatus('saving'); clearTimeout(timer.current); timer.current = setTimeout(() => setStatus(failure ? 'error' : 'success'), 900); };
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button className="lab-trigger"><IconLayoutGrid size={17}/><span>组件体验</span></button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="lab-overlay"/><Dialog.Content className="lab-dialog">
      <div className="lab-header"><div className="lab-title-icon"><IconLayoutGrid size={22}/></div><div><span className="catalog-eyebrow">A CLOSER LOOK</span><Dialog.Title>看看细节，试试手感</Dialog.Title><Dialog.Description>同一套交互，感受 {theme.name} 的材质与反馈。</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="关闭组件体验"><IconX size={20}/></button></Dialog.Close></div>
      <div className="lab-body">
        <div className="lab-theme-row"><IconPalette size={16}/><label htmlFor="lab-theme">当前主题</label><select id="lab-theme" value={appearance.preset} onChange={event => onAppearanceChange(previous => ({ ...previous, preset: event.target.value }))}>{themes.map(item => <option key={item.id} value={item.id}>{item.name} · {item.mode === 'dark' ? '深色' : '浅色'}</option>)}</select></div>
        <section className="lab-section"><div className="lab-section-heading"><h3>操作与选择</h3><span>悬停 · 按下 · 聚焦</span></div><div className="lab-actions"><button className="button primary" onClick={save} disabled={status === 'saving'}>{status === 'saving' ? <IconLoader2 className="lab-spinner" size={16}/> : <IconArrowRight size={16}/>}<span>{status === 'saving' ? '正在保存…' : '模拟保存'}</span></button><button className="button secondary" onClick={() => { clearTimeout(timer.current); setStatus('idle'); }}>重置反馈</button><button className="button secondary" disabled>暂不可用</button></div></section>
        <section className="lab-section"><div className="lab-section-heading"><h3>表单与菜单</h3><span>可直接编辑与切换</span></div><label htmlFor="demo-name" className="lab-field-label">配置名称</label><input id="demo-name" className="lab-input" defaultValue="我的日常工作流" placeholder="输入配置名称"/>
          <div className="lab-setting"><span><strong>完成提醒</strong><small>工作完成后给我一个提示</small></span><input className="switch" type="checkbox" role="switch" aria-label="完成提醒" checked={enabled} onChange={event => setEnabled(event.target.checked)}/></div>
          <div className="lab-setting"><span><strong>提醒方式</strong><small>打开菜单，查看浮层与选中态</small></span><Popover.Root open={menuOpen} onOpenChange={setMenuOpen}><Popover.Trigger asChild><button className="button secondary"><IconBell size={15}/>{choice}<IconChevronDown size={14}/></button></Popover.Trigger><Popover.Portal><Popover.Content className="lab-menu" sideOffset={8} align="end" collisionPadding={14} aria-label="提醒方式"><div role="group" aria-label="提醒方式选择">{['仅完成时','完成与失败时','保持安静'].map(item => <button aria-pressed={choice === item} key={item} onClick={() => { setChoice(item); setMenuOpen(false); }}><span>{item}</span>{choice === item && <IconCheck size={15}/>}</button>)}</div></Popover.Content></Popover.Portal></Popover.Root></div>
        </section>
        <div className={`lab-feedback ${status}`} aria-live="polite">{status === 'error' ? <IconAlertCircle size={20}/> : status === 'saving' ? <IconLoader2 className="lab-spinner" size={20}/> : <IconCircleCheck size={20}/>}<div><strong>{status === 'error' ? '保存失败，修改仍然保留' : status === 'success' ? '预览已保存' : status === 'saving' ? '正在保存预览…' : '反馈也属于主题的一部分'}</strong><p>{status === 'error' ? '关闭下方的失败模拟后，可以再次尝试。' : status === 'success' ? '这是组件演示，不会修改真实配置。' : status === 'saving' ? '按钮会保持尺寸，并阻止重复提交。' : '点击“模拟保存”，体验等待、成功和失败。'}</p></div></div>
      </div>
      <footer className="lab-footer"><label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)}/>模拟保存失败</label><Dialog.Close asChild><button className="button secondary">完成体验<IconCheck size={15}/></button></Dialog.Close></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
