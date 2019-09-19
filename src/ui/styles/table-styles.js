jb.component('table.with-headers', { /* table.withHeaders */
  params: [ 
    { id: 'hideHeaders',  as: 'boolean' },
  ],
  type: 'table.style,itemlist.style',
  impl: customStyle({
    template: (cmp,state,h) => h('table',{},[
        ...(cmp.hideHeaders ? [] : [h('thead',{},h('tr',{},
          cmp.fields.map(f=>h('th',{'jb-ctx': f.ctxId, style: { width: f.width ? f.width + 'px' : ''} }, jb.ui.fieldTitle(cmp,f,h))) ))]),
        h('tbody',{class: 'jb-drag-parent'},
            state.items.map((item,index)=> jb.ui.item(cmp,h('tr',{ class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(cmp.ctx.setData(item))},cmp.fields.map(f=>
              h('td', { 'jb-ctx': jb.ui.preserveFieldCtxWithItem(f,item), class: f.class }, 
                f.control ? h(f.control(item,index),{index, row: item}) : f.fieldData(item,index))))
              ,item))
        ),
        state.items.length == 0 ? 'no items' : ''
        ]),
    css: `{border-spacing: 0; text-align: left}
    >tbody>tr>td { padding-right: 5px }
    {width: 100%}
    `,
    features: table.initTableOrItemlist()
  })
})


jb.component('table.mdl', { /* table.mdl */
  type: 'table.style,itemlist.style',
  params: [
    {
      id: 'classForTable',
      as: 'string',
      defaultValue: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp'
    },
    {
      id: 'classForTd',
      as: 'string',
      defaultValue: 'mdl-data-table__cell--non-numeric'
    }
  ],
  impl: customStyle({
    template: (cmp,state,h) => h('table',{ class: cmp.classForTable },[
        h('thead',{},h('tr',{},cmp.fields.map(f=>h('th',{
          'jb-ctx': f.ctxId, 
          class: [cmp.classForTd]
            .concat([ 
              (state.sortOptions && state.sortOptions.filter(o=>o.field == f)[0] || {}).dir == 'asc' ? 'mdl-data-table__header--sorted-ascending': '',
              (state.sortOptions && state.sortOptions.filter(o=>o.field == f)[0] || {}).dir == 'des' ? 'mdl-data-table__header--sorted-descending': '',
            ]).filter(x=>x).join(' '), 
          style: { width: f.width ? f.width + 'px' : ''},
          onclick: ev => cmp.toggleSort(f),
          }
          ,jb.ui.fieldTitle(cmp,f,h))) )),
        h('tbody',{class: 'jb-drag-parent'},
            state.items.map((item,index)=> jb.ui.item(cmp,h('tr',{ class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(cmp.ctx.setData(item))},cmp.fields.map(f=>
              h('td', { 'jb-ctx': jb.ui.preserveFieldCtxWithItem(f,item), class: (f.class + ' ' + cmp.classForTd).trim() }, f.control ? h(f.control(item,index),{row:item, index: index}) : f.fieldData(item,index))))
              ,item))
        ),
        state.items.length == 0 ? 'no items' : ''
        ]),
    css: '{width: 100%}',
    features: [table.initTableOrItemlist(), table.initSort()]
  })
})
