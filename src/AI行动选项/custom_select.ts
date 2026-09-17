import { gsap } from 'gsap';

type CustomSelectControl = {
  select: HTMLSelectElement;
  host: HTMLElement;
  trigger: HTMLButtonElement;
  list: HTMLSpanElement;
  label: string;
  active: number;
  opensUpward: boolean;
};

function prefersReducedMotion(control: CustomSelectControl): boolean {
  return control.trigger.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** 保留隐藏 select 作为配置读写入口，可见菜单统一使用卡库控件。 */
export function mountCustomSelects($root: JQuery<HTMLElement>) {
  const root = $root[0];
  const doc = root.ownerDocument;
  const controls: CustomSelectControl[] = Array.from(
    root.querySelectorAll<HTMLSelectElement>('.tlao-select-control select'),
  ).map(select => {
    const host = select.parentElement!;
    const trigger = doc.createElement('button');
    const list = doc.createElement('span');
    const label = select.closest('label')?.querySelector('span')?.textContent?.trim() || '选择';
    trigger.type = 'button';
    trigger.className = 'tlao-dropdown-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    list.id = `${select.id}-options`;
    list.className = 'tlao-dropdown-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    list.hidden = true;
    trigger.setAttribute('aria-controls', list.id);
    select.hidden = true;
    host.append(trigger);
    root.append(list);
    return { select, host, trigger, list, label, active: -1, opensUpward: false };
  });
  let opened: CustomSelectControl | undefined;

  function finishClose(control: CustomSelectControl) {
    control.list.hidden = true;
    gsap.set(control.list, { clearProps: 'opacity,visibility,transform,transformOrigin,pointerEvents' });
  }

  function close(immediate = false) {
    const control = opened;
    if (!control) return;
    opened = undefined;
    control.trigger.classList.remove('is-open');
    control.trigger.setAttribute('aria-expanded', 'false');
    control.trigger.removeAttribute('aria-activedescendant');
    gsap.killTweensOf(control.list);

    if (immediate || prefersReducedMotion(control)) {
      finishClose(control);
      return;
    }

    gsap.to(control.list, {
      autoAlpha: 0,
      y: control.opensUpward ? 4 : -4,
      scaleY: 0.96,
      pointerEvents: 'none',
      duration: 0.12,
      ease: 'power1.in',
      overwrite: true,
      onComplete: () => finishClose(control),
    });
  }

  function highlight(control: CustomSelectControl, index: number) {
    control.active = index;
    Array.from(control.list.children).forEach((node, i) => node.classList.toggle('is-highlighted', i === index));
    const option = control.list.children[index] as HTMLElement | undefined;
    if (option) {
      control.trigger.setAttribute('aria-activedescendant', option.id);
      const itemRect = option.getBoundingClientRect();
      const listRect = control.list.getBoundingClientRect();
      if (itemRect.top < listRect.top) control.list.scrollTop -= listRect.top - itemRect.top;
      else if (itemRect.bottom > listRect.bottom) control.list.scrollTop += itemRect.bottom - listRect.bottom;
    }
  }

  function refresh() {
    for (const control of controls) {
      const { select, trigger, list } = control;
      const selected = select.options[select.selectedIndex]?.textContent || '请选择';
      trigger.textContent = selected;
      trigger.setAttribute('aria-label', `${control.label}：${selected}`);
      trigger.disabled = select.disabled;
      list.replaceChildren();
      Array.from(select.options).forEach((option, index) => {
        const item = doc.createElement('span');
        item.id = `${list.id}-${index}`;
        item.className = 'tlao-dropdown-option';
        item.dataset.index = String(index);
        item.textContent = option.textContent;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.setAttribute('aria-disabled', String(option.disabled));
        list.append(item);
      });
      if (opened === control) {
        if (select.disabled) close();
        else highlight(control, select.selectedIndex);
      }
    }
  }

  function open(control: CustomSelectControl) {
    close(true);
    refresh();
    if (control.select.disabled) return;
    opened = control;
    // 浮层挂在设置根节点，绕过面板滚动裁切；空间不足时向上展开。
    const anchor = control.trigger.getBoundingClientRect();
    const boundary = root.getBoundingClientRect();
    const viewportHeight = doc.defaultView?.innerHeight ?? boundary.bottom;
    const bottom = Math.min(boundary.bottom, viewportHeight);
    const top = Math.max(boundary.top, 0);
    const below = Math.max(0, bottom - anchor.bottom - 8);
    const above = Math.max(0, anchor.top - top - 8);
    const upwards = below < 180 && above > below;
    control.opensUpward = upwards;
    control.list.style.width = `${Math.min(anchor.width, boundary.width)}px`;
    control.list.style.left = `${Math.max(0, Math.min(anchor.left - boundary.left, boundary.width - anchor.width))}px`;
    control.list.style.maxHeight = `${Math.min(240, upwards ? above : below)}px`;
    control.list.style.top = 'auto';
    control.list.style.bottom = 'auto';
    if (upwards) control.list.style.bottom = `${boundary.bottom - anchor.top + 4}px`;
    else control.list.style.top = `${anchor.bottom - boundary.top + 4}px`;
    control.list.hidden = false;
    control.trigger.classList.add('is-open');
    control.trigger.setAttribute('aria-expanded', 'true');
    highlight(control, control.select.selectedIndex);

    gsap.killTweensOf(control.list);
    if (prefersReducedMotion(control)) {
      gsap.set(control.list, { clearProps: 'opacity,visibility,transform,transformOrigin,pointerEvents' });
      return;
    }

    gsap.fromTo(
      control.list,
      {
        autoAlpha: 0,
        y: upwards ? 4 : -4,
        scaleY: 0.96,
        transformOrigin: upwards ? 'bottom center' : 'top center',
        pointerEvents: 'none',
      },
      {
        autoAlpha: 1,
        y: 0,
        scaleY: 1,
        pointerEvents: 'auto',
        duration: 0.16,
        ease: 'power1.out',
        overwrite: true,
        clearProps: 'opacity,visibility,transform,transformOrigin,pointerEvents',
      },
    );
  }

  function choose(control: CustomSelectControl, index: number) {
    const option = control.select.options[index];
    if (!option || option.disabled || control.select.disabled) return;
    control.select.selectedIndex = index;
    close();
    refresh();
    // 走原来的委托 change 事件，继续触发模板刷新和即时保存。
    $(control.select).trigger('change');
    control.trigger.focus({ preventScroll: true });
    if (!prefersReducedMotion(control)) {
      gsap.fromTo(
        control.trigger,
        { y: -1, scale: 0.99 },
        {
          y: 0,
          scale: 1,
          duration: 0.16,
          ease: 'back.out(2)',
          overwrite: 'auto',
          clearProps: 'transform',
        },
      );
    }
  }

  function click(event: Event) {
    const target = event.target as HTMLElement;
    for (const control of controls) {
      if (control.trigger.contains(target)) {
        event.preventDefault();
        if (opened === control) close();
        else open(control);
        return;
      }
      const option = target.closest<HTMLElement>('.tlao-dropdown-option');
      if (option && control.list.contains(option)) {
        event.preventDefault();
        choose(control, Number(option.dataset.index));
        return;
      }
    }
    close();
  }

  function keydown(event: KeyboardEvent) {
    const control = controls.find(item => item.trigger === event.target);
    if (!control) return;
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = opened === control;
      if (!wasOpen) open(control);
      const enabled = Array.from(control.select.options).flatMap((o, i) => (o.disabled ? [] : [i]));
      if (!enabled.length) return;
      const position = enabled.indexOf(control.active);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? enabled.length - 1
            : Math.max(
                0,
                Math.min(enabled.length - 1, position + (wasOpen ? (event.key === 'ArrowDown' ? 1 : -1) : 0)),
              );
      highlight(control, enabled[next]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (opened === control) choose(control, control.active);
      else open(control);
    }
  }

  function focusout(event: FocusEvent) {
    if (opened && !opened.host.contains(event.relatedTarget as Node | null)) close();
  }

  function pointerdown(event: PointerEvent) {
    if (opened?.list.contains(event.target as Node)) event.preventDefault();
  }

  function scroll(event: Event) {
    if (opened && event.target !== opened.list) close(true);
  }

  const closeImmediately = () => close(true);

  refresh();
  doc.addEventListener('click', click);
  root.addEventListener('keydown', keydown);
  root.addEventListener('focusout', focusout);
  root.addEventListener('pointerdown', pointerdown);
  doc.addEventListener('scroll', scroll, true);
  doc.defaultView?.addEventListener('resize', closeImmediately);
  return {
    refresh,
    destroy() {
      close(true);
      doc.removeEventListener('click', click);
      root.removeEventListener('keydown', keydown);
      root.removeEventListener('focusout', focusout);
      root.removeEventListener('pointerdown', pointerdown);
      doc.removeEventListener('scroll', scroll, true);
      doc.defaultView?.removeEventListener('resize', closeImmediately);
      for (const { select, trigger, list } of controls) {
        gsap.killTweensOf([trigger, list]);
        select.hidden = false;
        trigger.remove();
        list.remove();
      }
    },
  };
}
