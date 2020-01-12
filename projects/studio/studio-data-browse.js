jb.component('studio.watchable-or-passive', { /* studio.watchableOrPassive */
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: (ctx,path) => path.match(/~watchable/) ? 'Watchable' : 'Passive'
})

jb.component('studio.copy-data-resource-to-comp', {
  type: 'action',
  params: [
    {id: 'path', as: 'string'},
    {id: 'name', as: 'string'}
  ],
  impl: writeValue(studio.profileAsText('%$path%'),
    (ctx,vars,{name}) => jb.prettyPrint(new jb.studio.previewjb.jbCtx().exp('%$'+name+'%'))
  )
})

jb.component('studio.open-resource', { /* studio.openResource */
  type: 'action',
  params: [
    {id: 'path', as: 'string'},
    {id: 'name', as: 'string'}
  ],
  impl: runActions(
    studio.copyDataResourceToComp('%$path%', '%$name%'),
    openDialog({
        style: dialog.editSourceStyle({id: 'edit-data-resource', width: 600}),
        content: editableText({
          databind: studio.profileAsText('%$path%'),
          style: editableText.studioCodemirrorTgp(),
          features: interactive((ctx,{cmp}) => 
            ctx.vars.$dialog.refresh = () => {
              ctx.run(studio.copyDataResourceToComp('%$path%','%$name%'))
              cmp.refresh && cmp.refresh()
          })
        }),
        title: pipeline(studio.watchableOrPassive('%$path%'), 'Edit %$name% (%%)'),
        features: [
          css('.jb-dialog-content-parent {overflow-y: hidden}'),
          dialogFeature.resizer(true)
        ]
      })
  )
})

jb.component('studio.open-new-resource', { /* studio.openNewResource */
  params: [
    {id: 'watchableOrPassive', as: 'string'}
  ],
  type: 'action',
  impl: openDialog({
    style: dialog.dialogOkCancel(),
    content: group({
      style: group.div(),
      controls: [
        editableText({
          title: 'resource name',
          databind: '%$name%',
          style: editableText.mdcInput(),
          features: feature.onEnter(dialog.closeContainingPopup())
        })
      ],
      features: css.padding({top: '14', left: '11'})
    }),
    title: 'New %$watchableOrPassive% Data Source',
    onOK: [
      studio.newComp('data-resource.%$name%',
        obj(prop('%$watchableOrPassive%Data', `put your data here.
E.g.
hello world
[1,2,3]
{ x: 7, y: 3}`))
      ),
      studio.openResource('data-resource.%$name%~%$watchableOrPassive%Data', '%$name%')
    ],
    modal: true,
    features: [
      variable({name: 'name', watchable: true}),
      dialogFeature.autoFocusOnFirstInput()
    ]
  })
})

jb.component('studio.data-resource-menu', { /* studio.dataResourceMenu */
  type: 'menu.option',
  impl: menu.menu({
    title: 'Data',
    options: [
      menu.endWithSeparator({
        options: dynamicControls({
          controlItems: ctx => jb.studio.projectCompsAsEntries()
          .filter(e=>e[1].watchableData !== undefined || e[1].passiveData !== undefined)
            .map(e=> {
              const watchableOrPassive = e[1].watchableData !== undefined ? 'watchable' : 'passive'
              const upper = watchableOrPassive.charAt(0).toUpperCase() + watchableOrPassive.slice(1)
              const name = jb.removeDataResourcePrefix(e[0])
              return {
                name,
                title: `${name} (${upper})`,
                path: `${e[0]}~${watchableOrPassive}Data`
              }
            }
            ),
          genericControl: menu.action({
            title: '%$controlItem/title%',
            action: studio.openResource('%$controlItem/path%', '%$controlItem/name%')
          })
        })
      }),
      menu.action({
        title: 'New Watchable',
        action: studio.openNewResource('watchable')
      }),
      menu.action({title: 'New Passive', action: studio.openNewResource('passive')})
    ]
  })
})



