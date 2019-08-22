(function () {
const st = jb.studio;

st.compsHistory = [];
st.undoIndex = 0;

function setToVersion(versionIndex, ctx, after) {
  const version = st.compsHistory[versionIndex];
  if (!version || !version.opEvent) debugger;

  let opEvent = Object.assign({}, version.opEvent);
  opEvent.oldVal = version.opEvent.newVal;
  opEvent.newVal = version.opEvent.oldVal;
  opEvent.srcCtx = ctx;

  if (after) {
    st.previewjb.comps = version.after;
    st.compsRefHandler.resourceVersions = version.opEvent.resourceVersionsAfter;
  } else {
    st.previewjb.comps = version.before;
    st.compsRefHandler.resourceVersions = version.opEvent.resourceVersionsBefore;
  }

  st.compsRefHandler.resourceChange.next(opEvent);
}

jb.component('studio.undo',  /* studio_undo */ {
  type: 'action',
  impl: ctx => {
    if (st.undoIndex > 0)
      setToVersion(--st.undoIndex, ctx)
  }
})

jb.component('studio.clean-selection-preview',  /* studio_cleanSelectionPreview */ {
  type: 'action',
  impl: () => {
    if (st.compsHistory.length > 0)
      st.previewjb.comps = st.compsHistory.slice(-1)[0].after;
  }
})

jb.component('studio.revert',  /* studio_revert */ {
  type: 'action',
  params: [
    {id: 'toIndex', as: 'number'}
  ],
  impl: (ctx, toIndex) => {
    if (st.compsHistory.length == 0 || toIndex < 0) return;
    st.undoIndex = toIndex;
    st.compsHistory = st.compsHistory.slice(0, toIndex + 1);
    setToVersion(st.undoIndex, ctx)
  }
})

jb.component('studio.redo',  /* studio_redo */ {
  type: 'action',
  impl: ctx => {
    if (st.undoIndex < st.compsHistory.length)
      setToVersion(st.undoIndex++, ctx, true)
  }
})

jb.component('studio.copy',  /* studio_copy */ {
  type: 'action',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: (ctx, path) => {
    try {
      st.clipboard = eval('(' + jb.prettyPrint(st.valOfPath(path)) + ')')
    } catch(e) {}
  }
})

jb.component('studio.paste',  /* studio_paste */ {
  type: 'action',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: (ctx, path) =>
    (st.clipboard != null) && jb.writeValue(st.refOfPath(path), st.clipboard, ctx)
})

jb.component('studio.script-history-items',  /* studio_scriptHistoryItems */ {
  impl: ctx => st.compsHistory
})

jb.component('studio.comps-undo-index',  /* studio_compsUndoIndex */ {
  impl: ctx => st.undoIndex - 1
})

jb.component('studio.script-history',  /* studio_scriptHistory */ {
  type: 'control',
  impl: group({
    controls: [
      table({
        items: studio_scriptHistoryItems(),
        fields: [
          field_control({
            title: 'changed',
            control: button({
              title: studio_nameOfRef('%opEvent/ref%'),
              action: {$: 'studio.goto-path', path: studio_pathOfRef('%opEvent/ref%'), $recursive: true},
              style: button_href(),
              features: feature_hoverTitle(studio_pathOfRef('%opEvent/ref%'))
            }),
            width: '100'
          }),
          field({title: 'from', data: prettyPrint('%opEvent/oldVal%'), width: '200'}),
          field({title: 'to', data: prettyPrint('%opEvent/newVal%'), width: '200'}),
          field_control({
            title: 'undo/redo',
            control: button({
              title: 'revert to here',
              action: studio_revert('%undoIndex%'),
              style: button_href()
            }),
            width: '100'
          })
        ],
        style: table_withHeaders()
      })
    ],
    features: [
      watchObservable(ctx => st.compsRefHandler.resourceChange.debounceTime(500)),
      css_height({height: '400', overflow: 'auto', minMax: 'max'})
    ]
  })
})

jb.component('studio.open-script-history',  /* studio_openScriptHistory */ {
  type: 'action',
  impl: openDialog({
    style: dialog_studioFloating({id: 'script-history', width: '700', height: '400'}),
    content: studio_scriptHistory(),
    title: 'Script History'
  })
})

})()
