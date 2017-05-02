jb.component('group.section', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('section',{class:'jb-group'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,ctrl,h(ctrl)))),
    features:{$: 'group.init-group'}
  }
})


jb.component('group.div', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,ctrl,h(ctrl)))),
    features :{$: 'group.init-group'}
  }
})

jb.component('group.ul-li', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('ul',{ class: 'jb-itemlist'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,ctrl, h('li', {} ,h(ctrl))))),
    css: `{ list-style: none; padding: 0; margin: 0;}
    >li { list-style: none; padding: 0; margin: 0;}`
  },
})

jb.component('group.expandable', {
  type: 'group.style',
  impl :{$: 'custom-style', 
    template: (cmp,state,h) => h('section',{ class: 'jb-group'},[
        h('div',{ class: 'header'},[
          h('div',{ class: 'title'}, state.title),
          h('button',{ class: 'mdl-button mdl-button--icon', onclick: _=> cmp.toggle(), title: cmp.expand_title() },
            h('i',{ class: 'material-icons'}, state.show ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
          )
        ])
      ].concat(state.show ? state.ctrls.map(ctrl=> h('div',{ },h(ctrl))): [])
    ),
    css: `>.header { display: flex; flex-direction: row; }
        >.header>button:hover { background: none }
        >.header>button { margin-left: auto }
        >.header.title { margin: 5px }`, 
    features :[ 
        {$: 'group.init-group' },
        {$: 'group.init-expandable' },
      ]
    }, 
})

jb.component('group.init-expandable', {
  type: 'feature', category: 'group:0',
  impl: ctx => ({
        init: cmp => {
            cmp.state.show = true;
            cmp.expand_title = () => cmp.show ? 'collapse' : 'expand';
            cmp.toggle = function () { cmp.show = !cmp.show; };
        },
  })
})

jb.component('group.accordion', {
  type: 'group.style',
  impl :{$: 'custom-style', 
    template: (cmp,state,h) => h('section',{ class: 'jb-group'},
        state.ctrls.map((ctrl,index)=> jb.ui.item(cmp,ctrl,h('div',{ class: 'accordion-section' },[
          h('div',{ class: 'header', onclick: _=> cmp.show(index) },[
            h('div',{ class: 'title'}, ctrl.title),
            h('button',{ class: 'mdl-button mdl-button--icon', title: cmp.expand_title(ctrl) }, 
              h('i',{ class: 'material-icons'}, state.shown == index ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
            )
          ])].concat(state.shown == index ? [h(ctrl)] : [])))        
    )),
    css: `>.accordion-section>.header { display: flex; flex-direction: row; }
        >.accordion-section>.header>button:hover { background: none }
        >.accordion-section>.header>button { margin-left: auto }
        >.accordion-section>.header>.title { margin: 5px }`, 
      features : [ 
        {$: 'group.init-group' },
        {$: 'group.init-accordion' },
      ]
    }, 
})

jb.component('group.init-accordion', {
  type: 'feature', category: 'group:0',
  params: [
    { id: 'keyboardSupport', as: 'boolean' },
    { id: 'autoFocus', as: 'boolean' }
  ],
  impl: ctx => ({
    onkeydown: ctx.params.keyboardSupport,
    init: cmp => {
      cmp.state.shown = 0;
      cmp.expand_title = index => 
        index == cmp.state.shown ? 'collapse' : 'expand';

      cmp.show = index => 
        cmp.setState({shown: index});

      cmp.next = diff =>
        cmp.setState({shown: (cmp.state.index + diff + cmp.ctrls.length) % cmp.ctrls.length});
    },
    afterViewInit: cmp => {
      if (ctx.params.keyboardSupport) {
        cmp.onkeydown.filter(e=> e.keyCode == 33 || e.keyCode == 34) // pageUp/Down
            .subscribe(e=>
              cmp.next(e.keyCode == 33 ? -1 : 1))
      }
    }    
  })
})

jb.component('group.tabs', {
  type: 'group.style',
  params: [
    { id: 'width', as : 'number' },
  ],
  impl :{$: 'style-by-control', __innerImplementation: true,
    modelVar: 'tabsModel',
    control :{$: 'group', controls: [
      {$: 'group', title: 'thumbs',
        features :{$: 'group.init-group'}, 
        style :{$: 'layout.horizontal' },
        controls :{$: 'dynamic-controls', 
          itemVariable: 'tab',
          controlItems : '%$tabsModel/controls%',
          genericControl: {$: 'button', 
            title: '%$tab/jb_title%', 
            action :{$: 'write-value', value: '%$tab%', to: '%$selectedTab%' },
            style :{$: 'button.mdl-flat-ripple' }, 
            features: [
              {$: 'css.width', width: '%$width%' }, 
              {$: 'css', css: '{text-align: left}' }
            ]
          },
        },
      },
      ctx => 
        jb.val(ctx.exp('%$selectedTab%')), 
    ],
    features : [ 
        {$: 'group.var', name: 'selectedTab', value: '%$tabsModel/controls[0]%' },
        {$: 'group.init-group'},
    ]
  }}
})

jb.component('toolbar.simple', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{class:'toolbar'},
        state.ctrls.map(ctrl=> h(ctrl))),
    css: `{ 
            display: flex;
            background: #F5F5F5; 
            height: 33px; 
            width: 100%;
            border-bottom: 1px solid #D9D9D9; 
            border-top: 1px solid #fff;
        }
        >* { margin-right: 0 }`,
    features :{$: 'group.init-group'}
  }
})

