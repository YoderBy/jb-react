jb.ns('group,layout,tabs')

jb.component('group', { /* group */
  type: 'control',
  category: 'group:100,common:90',
  params: [
    {id: 'title', as: 'string', dynamic: true},
    {id: 'layout', type: 'layout', defaultValue: layout.vertical() },
    {id: 'style',type: 'group.style', defaultValue: group.div(), mandatory: true, dynamic: true},
    {id: 'controls',type: 'control[]',mandatory: true,flattenArray: true,dynamic: true,composite: true},
    {id: 'features', type: 'feature[]', dynamic: true}
  ],
  impl: ctx => jb.ui.ctrl(ctx, ctx.params.layout)
})

jb.component('group.init-group', { /* group.initGroup */
  type: 'feature',
  category: 'group:0',
  impl: calcProp('ctrls', '%$$model.controls%')
})

jb.component('inline-controls', { /* inlineControls */
  type: 'control',
  description: 'controls without a wrapping group',
  params: [
    {id: 'controls',type: 'control[]',mandatory: true,flattenArray: true,dynamic: true,composite: true }
  ],
  impl: ctx => ctx.params.controls().filter(x=>x)
})

jb.component('dynamic-controls', { /* dynamicControls */
  type: 'control',
  description: 'calculated controls by data items without a wrapping group',
  params: [
    {id: 'controlItems', type: 'data', as: 'array', mandatory: true, dynamic: true},
    {id: 'genericControl', type: 'control', mandatory: true, dynamic: true},
    {id: 'itemVariable', as: 'string', defaultValue: 'controlItem'},
  ],
  impl: (ctx,controlItems,genericControl,itemVariable) => (controlItems() || [])
      .map(controlItem => jb.tosingle(genericControl(ctx.setVar(itemVariable,controlItem).setData(controlItem))))
})

jb.component('group.first-succeeding', { /* group.firstSucceeding */
  type: 'feature',
  category: 'group:70',
  description: 'Used with controlWithCondition. Takes the fhe first succeeding control',
  impl: features(
    () => ({calcHash: ctx => jb.asArray(ctx.vars.$model.controls.profile).reduce((res,prof,i) => {
        if (res) return res
        const found = prof.condition == undefined || ctx.vars.$model.ctx.setVars(ctx.vars).runInner(prof.condition,{ as: 'boolean'},`controls.${i}.condition`)
        if (found) 
          return i + 1 // avoid index 0
      }, null),
    }),
    calcProp({id: 'ctrls', priority: 5, value: ctx => {
      const index = ctx.vars.$props.cmpHash-1
      if (isNaN(index)) return []
      const prof = jb.asArray(ctx.vars.$model.controls.profile)[index]
      return [ctx.vars.$model.ctx.setVars(ctx.vars).runInner(prof,{type: 'control'},`controls.${index}`)]
     } 
    }),
  )
})

jb.component('control-with-condition', { /* controlWithCondition */
  type: 'control',
  description: 'Used with group.firstSucceeding',
  category: 'group:10',
  macroByValue: true,
  params: [
    {id: 'condition', type: 'boolean', dynamic: true, mandatory: true, as: 'boolean'},
    {id: 'control', type: 'control', mandatory: true, dynamic: true},
    {id: 'title', as: 'string'}
  ],
  impl: (ctx,condition,ctrl) => condition(ctx) && ctrl(ctx)
})
