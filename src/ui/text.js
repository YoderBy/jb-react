jb.ns('text')

jb.component('text', { /* text */
  type: 'control',
  category: 'control:100,common:100',
  params: [
    {id: 'text', as: 'ref', mandatory: true, templateValue: 'my text', dynamic: true},
    {id: 'title', as: 'ref', mandatory: true, templateValue: 'my title', dynamic: true},
    {id: 'style', type: 'text.style', defaultValue: text.span(), dynamic: true},
    {id: 'features', type: 'feature[]', dynamic: true}
  ],
  impl: ctx => jb.ui.ctrl(ctx)
})

jb.component('label', {...jb.comps.text,type: 'depricated-control'} )

jb.component('text.bind-text', { /* text.bindText */
  type: 'feature',
  category: 'text:0',
  impl: features(
    watchAndCalcModelProp('text', ({data}) => jb.ui.toVdomOrStr(data)),
    () => ({studioFeatures :{$: 'feature.contentEditable', param: 'text' }})
  )
})

jb.component('text.allow-asynch-value', { /* text.allowAsynchValue */
  type: 'feature',
  impl: features(
    calcProp({id: 'text', value: (ctx,{cmp}) => cmp.text || ctx.vars.$props.text}),
    interactive(
        (ctx,{cmp}) => {
      if (cmp.text) return
      const val = jb.ui.toVdomOrStr(ctx.vars.$model.text(cmp.ctx))
      if (val && typeof val.then == 'function')
        val.then(res=>cmp.refresh({text: jb.ui.toVdomOrStr(res)},{srcCtx: ctx.componentContext}))
    }
      )
  )
})

jb.component('text.htmlTag', { /* text.htmlTag */
  type: 'text.style',
  params: [
    {id: 'htmlTag', as: 'string', defaultValue: 'p', options: 'span,p,h1,h2,h3,h4,h5,div,li,article,aside,details,figcaption,figure,footer,header,main,mark,nav,section,summary,label'},
    {id: 'cssClass', as: 'string'}
  ],
  impl: customStyle({
    template: (cmp,{text,htmlTag,cssClass},h) => h(htmlTag,{class: cssClass},text),
    features: text.bindText()
  })
})

jb.component('text.no-wrapping-tag', { /* text.noWrappingTag */
  type: 'text.style',
  category: 'text:0',
  impl: customStyle({
    template: (cmp,{text},h) => text,
    features: text.bindText()
  })
})

jb.component('text.span', { /* text.span */
  type: 'text.style',
  impl: customStyle({
    template: (cmp,{text},h) => h('span',{},text),
    features: text.bindText()
  })
})

;[1,2,3,4,5,6].map(level=>jb.component(`header.h${level}`, {
  type: 'text.style',
  impl: customStyle({
    template: (cmp,{text},h) => h(`h${level}`,{},text),
    features: text.bindText()
  })
}))

;[1,2,3,4,5,6].map(level=>jb.component(`header.mdc-headline${level}`, {
  type: 'text.style',
  impl: customStyle({
    template: (cmp,{text},h) => h('h2',{class: `mdc-typography mdc-typography--headline${level}`},text),
    features: text.bindText()
  })
}))

;[1,2].map(level=>jb.component(`header.mdc-subtitle${level}`, {
  type: 'text.style',
  impl: customStyle({
    template: (cmp,{text},h) => h('h2',{class: `mdc-typography mdc-typography--subtitle${level}`},text),
    features: text.bindText()
  })
}))

;[1,2].map(level=>jb.component(`text.mdc-body${level}`, {
  type: 'text.style',
  impl: customStyle({
    template: (cmp,{text},h) => h('h2',{class: `mdc-typography mdc-typography--body${level}`},text),
    features: text.bindText()
  })
}))

jb.component('text.highlight', { /* text.highlight */
  type: 'data',
  macroByValue: true,
  params: [
    {id: 'base', as: 'string', dynamic: true},
    {id: 'highlight', as: 'string', dynamic: true},
    {id: 'cssClass', as: 'string', defaultValue: 'mdl-color-text--deep-purple-A700'}
  ],
  impl: (ctx,base,highlightF,cssClass) => {
    const h = highlightF(), b = base();
    if (!h || !b) return b;
    const highlight = (b.match(new RegExp(h,'i'))||[])[0]; // case sensitive highlight
    if (!highlight) return b;
    return jb.ui.h('div',{},[  b.split(highlight)[0],
              jb.ui.h('span',{class: cssClass},highlight),
              b.split(highlight).slice(1).join(highlight)])
  }
})
