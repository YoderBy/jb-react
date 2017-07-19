jb.component('mdl-style.init-dynamic', {
  type: 'feature',
  params: [
  	{id: 'query', as: 'string'}
  ],
  impl: (ctx,query) =>
    ({
      afterViewInit: cmp => {
        var elems = query ? cmp.base.querySelectorAll(query) : [cmp.base];
        cmp.refreshMdl = _ => {
          jb.delay(1).then(_ => elems.forEach(el=> {
            if (!$.contains(document, el))
              return;
            componentHandler.downgradeElements(el);
            componentHandler.upgradeElement(el);
          }))
        };
        jb.delay(1).catch(e=>{}).then(_ =>
      	 elems.forEach(el=>
      	 	$.contains(document, el) && componentHandler.upgradeElement(el))).catch(e=>{})
      },
      destroy: cmp => {
        try {
      	 $.contains(document.documentElement, cmp.base) &&
          (query ? cmp.base.querySelectorAll(query) : [cmp.base]).forEach(el=>
      	 	   $.contains(document, el) && componentHandler.downgradeElements(el))
        } catch(e) {}
       }
    })
})

jb.component('mdl.ripple-effect', {
  type: 'feature',
  description: 'add ripple effect to buttons',
  impl: ctx => ({
      templateModifier: (vdom,cmp,state) => {
        vdom.children.push(jb.ui.h('span',{class:'mdl-ripple'}));
        return vdom;
      },
      css: '{ position: relative; overflow:hidden }',
      afterViewInit: cmp => {
          cmp.base.classList.add('mdl-js-ripple-effect');
          $.contains(document, $(cmp.base)[0]) && componentHandler.upgradeElement(cmp.base);
      },
      destroy: cmp =>
          $.contains(document, $(cmp.base)[0]) && componentHandler.downgradeElements(cmp.base)
   }),
})


// ****** label styles

jb.component('label.mdl-ripple-effect', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{class:'mdl-button mdl-js-button mdl-js-ripple-effect'},state.title),
        features :[
          {$: 'label.bind-title' },
          {$: 'mdl-style.init-dynamic'}
        ],
    }
});

jb.component('label.mdl-button', {
    type: 'label.style',
    params: [
      {id: 'width', as: 'number' }
    ],
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{class:'mdl-button mdl-js-button'},state.title),
        features :[
          {$: 'label.bind-title' },
          {$: 'mdl-style.init-dynamic'}
        ],
        css: '{? {width:%$width%px} ?}'
    }
});
