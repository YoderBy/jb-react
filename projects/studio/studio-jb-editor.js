(function() {
const st = jb.studio
jb.studio.probeResultCustomizers = []

jb.component('studio.jb-editor-path-for-edit', { /* studio.jbEditorPathForEdit */
  type: 'data',
  description: 'in case of array, use extra element path',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: (ctx,path) => {
    const ar = jb.studio.valOfPath(path);
    if (Array.isArray(ar))
      return path + '~' + ar.length;
    return path;
  }
})

jb.component('studio.open-jb-editor-menu', { /* studio.openJbEditorMenu */
  type: 'action',
  params: [
    {id: 'path', as: 'string'},
    {id: 'root', as: 'string'}
  ],
  impl: menu.openContextMenu({
    menu: studio.jbEditorMenu('%$path%', '%$root%'),
    features: dialogFeature.onClose(tree.regainFocus())
  })
})

jb.component('studio.prob-result-customization', { /* studio.probResultCustomization */
  type: 'data',
  params: [
    {id: 'probeResult', mandatory: true}
  ],
  impl: (ctx, probeResult) => {
    probeResult.result.forEach(res=> {
      //res.out = res.out && res.out.probeResultCustomization ? res.out.probeResultCustomization(ctx, res.out) : res.out
      (jb.studio.probeResultCustomizers||[]).forEach(customize => customize(ctx, res))
    })
    return probeResult;
  }
})

jb.component('studio.jb-editor-container', { /* studio.jbEditorContainer */
  type: 'feature',
  params: [
    {id: 'id', as: 'string', mandatory: true},
    {id: 'initialSelection', as: 'string', defaultValue: '%$path%'},
    {
      id: 'circuit',
      as: 'single',
      description: 'path or ctx of circuit to run the probe'
    }
  ],
  impl: list(
    variable({
        name: 'jbEditorCntrData',
        value: {'$': 'object', selected: '%$initialSelection%', circuit: '%$circuit%'},
        watchable: true
      })
  )
})

jb.component('studio.probe-results', { /* studio.probeResults */
  type: 'control',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: (ctx, path) => jb.delay(300).then(_ => {
    if (ctx.exp('%$stduio/fastPreview%')) {
      const inCtx = st.closestCtxOfLastRun(path) || new jb.jbCtx()
      return [{in: inCtx, out: st.isOfType(path,'action') ? null :
          st.previewjb.val(inCtx.runItself())}]
    }
    return ctx.run(pipe(studio.probe(path), '%result%'))
  })
})

jb.component('studio.data-browse', { /* studio.dataBrowse */
  type: 'control',
  params: [
    {id: 'obj', mandatory: true, as: 'value', defaultValue: '%%'},
    {id: 'width', as: 'number', defaultValue: 200}
  ],
  impl: group({
      controls: [
        control.firstSucceeding(
          [
            controlWithCondition(
              inGroup(list('JbComponent', 'jbCtx'), className('%$obj%')),
              label({title: className('%$obj%')})
            ),
            controlWithCondition(
              isOfType('string,boolean,number', '%$obj%'),
              label('%$obj%')
            ),
            controlWithCondition(
              isOfType('array', '%$obj%'),
              table({
                items: pipeline('%$obj%', slice(0, '%$maxItems%')),
                fields: field.control({
                  title: pipeline(count('%$obj%'), '%% items'),
                  control: studio.dataBrowse({obj: '%%', width: 200})
                }),
                style: table.mdl(
                  'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp',
                  'mdl-data-table__cell--non-numeric'
                ),
                features: [watchRef('%$maxItems%')]
              })
            ),
            controlWithCondition(isNull('%$obj%'), label('null')),
            tree({
              nodeModel: tree.jsonReadOnly('%$obj%', '%$title%'),
              style: tree.expandBox({noHead: true, showIcon: true}),
              features: [
                tree.selection({}),
                tree.keyboardSelection({}),
                css.width({width: '%$width%', minMax: 'max'})
              ]
            })
          ]
        ),
        controlWithCondition(
          and('%$obj/length% > 100', isOfType('string', '%$obj%')),
          button({
            title: 'open (%$obj/length%)',
            action: openDialog({
              style: dialog.showSourceStyle({id:'show-data'}),
              content:  group({
                features: css('{height: 100%} >div:last-child {height: 100%}'),
                style: group.tabs(),
                controls: [
                  editableText({
                    title: 'text',
                    databind: '%$obj%',
                    style: editableText.codemirror({
                      enableFullScreen: true,
                      height: '200',
                      mode: 'text',
                      debounceTime: 300,
                      lineNumbers: true,
                      readOnly: true
                    })
                  }),
                  html({title: 'html', html: '%$obj%', style: html.inIframe()})
                ]})
            }),
            style: button.href()
          }),
          'long text'
        ),
        controlWithCondition(
          and('%$obj/length% > 5', isOfType('array', '%$obj%'), '%$maxItems% == 5'),
          button({
            title: 'show (%$obj/length%)',
            action: writeValue('%$maxItems%', '100'),
            style: button.href(),
            features: [watchRef('%$maxItems%'), hidden('%$maxItems% == 5')]
          }),
          'large array'
        )
      ],
      features: [variable({name: 'maxItems', value: '5', watchable: 'true'})]
    })
})

jb.component('studio.probe-data-view', { /* studio.probeDataView */
  type: 'control',
  impl: group({
    controls: [itemlist({
        items: pipeline('%$probeResult%',slice(0,'%$maxItems%')),
        controls: [
          group({
            title: 'in (%$probeResult/length%)',
            controls: studio.dataBrowse(({data}) => st.previewjb.val(data.in.data)),
            features:[
              field.columnWidth(100),
              field.titleCtrl(button({
                    title: 'in (%$probeResult/length%)',
                    action: writeValue('%$maxItems%', '100'),
                    style: button.href(),
                    features: [watchRef('%$maxItems%'), ] // hidden('%$probeResult/length% > %$maxItems%')
              }))
            ]
          }),
          group({title: 'out', controls: studio.dataBrowse('%out%'), features: field.columnWidth(100)})
        ],
        style: table.mdl('mdl-data-table', 'mdl-data-table__cell--non-numeric'),
        features: [
          watchRef('%$maxItems%'),
          feature.if('%$jbEditorCntrData/selected%'),
          group.wait({
            for: studio.probeResults('%$jbEditorCntrData/selected%'),
            loadingControl: label('...'),
            varName: 'probeResult'
          }),
          css('{white-space: normal}'),
        ]
      }),
     ],
    features: [
      css.height({height: '600', overflow: 'auto', minMax: 'max'}),
      watchRef('%$jbEditorCntrData/selected%'),
      watchRef('%$studio/pickSelectionCtxId%'),
      watchRef('%$studio/refreshProbe%'),
      variable({name: 'maxItems', value: '5', watchable: true })
    ]
  })
})

jb.component('studio.open-jb-edit-property', { /* studio.openJbEditProperty */
  type: 'action',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: action.switch(
    Var('actualPath', studio.jbEditorPathForEdit('%$path%')),
    Var('paramDef', studio.paramDef('%$actualPath%')),
    [
      action.switchCase(endsWith('$vars', '%$path%')),
      action.switchCase(
        '%$paramDef/options%',
        openDialog({
          style: dialog.studioJbEditorPopup(),
          content: group({
            controls: [
              studio.jbFloatingInputRich('%$actualPath%')
            ],
            features: [
              feature.onEsc(dialog.closeContainingPopup(true)),
              feature.onEnter(dialog.closeContainingPopup(true), tree.regainFocus(), toggleBooleanValue('%$studio/refreshProbe%'))
            ]
          }),
          features: [
            dialogFeature.autoFocusOnFirstInput(),
            dialogFeature.onClose(tree.regainFocus())
          ]
        })
      ),
      action.switchCase(
        isOfType('function', studio.val('%$actualPath%')),
        studio.editSource('%$actualPath%')
      ),
      action.switchCase(
        studio.isOfType('%$actualPath%', 'data,boolean'),
        openDialog({
          style: dialog.studioJbEditorPopup(),
          content: studio.jbFloatingInput('%$actualPath%'),
          features: [
            dialogFeature.autoFocusOnFirstInput(),
            dialogFeature.onClose(
                toggleBooleanValue('%$studio/refreshProbe%'),
                tree.regainFocus()
            )
          ]
        })
      ),
      action.switchCase(
        Var('ptsOfType', studio.PTsOfType(studio.paramType('%$actualPath%'))),
        '%$ptsOfType/length% == 1',
        studio.setComp('%$path%', '%$ptsOfType[0]%')
      )
    ],
    studio.openNewProfileDialog({
      path: '%$actualPath%',
      type: studio.paramType('%$actualPath%'),
      mode: 'update',
      onClose: tree.regainFocus()
    })
  )
})

jb.component('studio.jb-editor-inteli-tree', { /* studio.jbEditorInteliTree */
  type: 'control',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: tree({
        nodeModel: studio.jbEditorNodes('%$path%'),
        style: tree.expandBox({showIcon: true}),
        features: [
          css.class('jb-editor'),
          tree.selection({
            databind: '%$jbEditorCntrData/selected%',
            autoSelectFirst: true,
            onRightClick: studio.openJbEditorMenu('%%', '%$path%')
          }),
          tree.keyboardSelection({
            onEnter: studio.openJbEditProperty('%$jbEditorCntrData/selected%'),
            onRightClickOfExpanded: studio.openJbEditorMenu('%%', '%$path%'),
            autoFocus: true,
            applyMenuShortcuts: studio.jbEditorMenu('%%', '%$path%')
          }),
          tree.dragAndDrop(),
          css.width({width: '500', selector: 'jb-editor'}),
          studio.watchScriptChanges()
        ]
   })
})

jb.component('studio.jb-editor', { /* studio.jbEditor */
  type: 'control',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: group({
    title: 'main',
    layout: layout.horizontalFixedSplit({leftWidth: '350px', rightWidth: '100%'}),
    controls: [
      studio.jbEditorInteliTree('%$path%'),
      studio.probeDataView()
    ],
    features: [id('jbEditor'), css.padding('10'), css.height({height: '800', minMax: 'max'})]
  })
})

jb.component('studio.open-jb-editor', { /* studio.openJbEditor */
  type: 'action',
  params: [
    {id: 'path', as: 'string'},
    {id: 'fromPath', as: 'string'},
    {id: 'newWindow', type: 'boolean', as: 'boolean'}
  ],
  impl: openDialog({
    vars: [
      Var('dialogId', {'$if': '%$newWindow%', then: '', else: 'jb-editor'}),
      Var('fromPath', '%$fromPath%'),
    ],
    style: dialog.studioFloating({id: '%$dialogId%', width: '860', height: '400'}),
    content: studio.jbEditor('%$path%'),
    menu: button({
      action: studio.openJbEditorMenu('%$path%', '%$path%'),
      style: button.mdlIcon('menu')
    }),
    title: studio.pathHyperlink('%$path%', 'Inteliscript'),
    features: [studio.jbEditorContainer('jb-editor'), dialogFeature.resizer()]
  })
})

jb.component('studio.open-component-in-jb-editor', { /* studio.openComponentInJbEditor */
  type: 'action',
  params: [
    {id: 'path', as: 'string'},
    {id: 'fromPath', as: 'string'}
  ],
  impl: runActions(
    Var('compPath', split({separator: '~', text: '%$path%', part: 'first'})),
    Var('fromPath', '%$fromPath%'),
    openDialog({
        style: dialog.studioFloating({id: 'jb-editor', width: '860', height: '400'}),
        content: studio.jbEditor('%$compPath%'),
        menu: button({
          action: studio.openJbEditorMenu('%$jbEditorCntrData/selected%', '%$path%'),
          style: button.mdlIcon('menu')
        }),
        title: studio.pathHyperlink('%$compPath%', 'Inteliscript'),
        features: [studio.jbEditorContainer('comp-in-jb-editor'), dialogFeature.resizer()]
      })
  )
})

jb.component('studio.expand-and-select-first-child-in-jb-editor', { /* studio.expandAndSelectFirstChildInJbEditor */
  type: 'action',
  impl: ctx => {
    const jbEditorElem = document.querySelector('.jb-editor')
    if (!jbEditorElem) return
    const ctxOfTree = ctx.vars.$tree ? ctx : jb.ctxDictionary[jbEditorElem.getAttribute('jb-ctx')];
    const cmp = ctxOfTree.vars.$tree && ctxOfTree.vars.$tree.cmp;
    if (!cmp) return;
    cmp.expanded[cmp.selected] = true;
    const firstChild = cmp.model.children(cmp.selected)[0];
    if (firstChild)
      cmp.selectionEmitter.next(firstChild)
    cmp.regainFocus && cmp.regainFocus()
  }
})

jb.component('menu.studio-wrap-with', { /* menu.studioWrapWith */
  type: 'menu.option',
  params: [
    {id: 'path', as: 'string'},
    {id: 'type', as: 'string'},
    {id: 'components', as: 'array'}
  ],
  impl: menu.dynamicOptions(
    {
      '$if': studio.isOfType('%$path%', '%$type%'),
      then: '%$components%',
      else: list()
    },
    menu.action({
      title: 'Wrap with %%',
      action: runActions(
        studio.wrap('%$path%', '%%'),
        studio.expandAndSelectFirstChildInJbEditor()
      )
    })
  )
})

jb.component('menu.studio-wrap-with-array', { /* menu.studioWrapWithArray */
  type: 'menu.option',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: {
    '$if': studio.canWrapWithArray('%$path%'),
    then: menu.action({
      title: 'Wrap with array',
      action: runActions(
        studio.wrapWithArray('%$path%'),
        studio.expandAndSelectFirstChildInJbEditor()
      )
    }),
    else: []
  }
})

jb.component('studio.add-variable', { /* studio.addVariable */
  type: 'action',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: onNextTimer(
    openDialog({
      id: 'add variable',
      style: dialog.popup(),
      content: group({
        controls: [
          editableText({
            title: 'variable name',
            databind: '%$dialogData/name%',
            style: editableText.mdlInput(),
            features: [
              feature.onEnter(
                writeValue(studio.ref('%$path%~%$dialogData/name%'), ''),
                dialog.closeContainingPopup(true),
                writeValue('%$jbEditorCntrData/selected%', '%$path%~%$dialogData/name%'),
                tree.redraw(true),
                tree.regainFocus()
              )
            ]
          })
        ],
        features: css.padding({top: '9', left: '20', right: '20'})
      }),
      title: 'New variable',
      modal: 'true',
      features: [
        dialogFeature.nearLauncherPosition({}),
        dialogFeature.autoFocusOnFirstInput()
      ]
    })
  )
})

})()