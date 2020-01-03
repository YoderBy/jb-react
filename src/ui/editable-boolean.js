jb.ns('editableBoolean')

jb.component('editable-boolean', { /* editableBoolean */
  type: 'control',
  category: 'input:20',
  params: [
    {id: 'databind', as: 'ref', type: 'boolean', mandaroy: true, dynamic: true, aa: 5},
    {
      id: 'style',
      type: 'editable-boolean.style',
      defaultValue: editableBoolean.checkbox(),
      dynamic: true
    },
    {id: 'title', as: 'string', dynamic: true},
    {id: 'textForTrue', as: 'string', defaultValue: 'yes', dynamic: true},
    {id: 'textForFalse', as: 'string', defaultValue: 'no', dynamic: true},
    {id: 'features', type: 'feature[]', dynamic: true}
  ],
  impl: ctx => jb.ui.ctrl(ctx, {
		init: cmp => {
			cmp.toggle = () => cmp.jbModel(!cmp.jbModel());
			cmp.setChecked = (e,source) => cmp.jbModel(e.target.checked,source)

			cmp.text = () => {
				if (!cmp.jbModel) return '';
				return cmp.jbModel() ? ctx.params.textForTrue(cmp.ctx) : ctx.params.textForFalse(cmp.ctx);
			}
			cmp.extendRefresh = () => cmp.strongRefresh()
			cmp.state.text = cmp.text()
		},
	})
})

jb.component('editable-boolean.keyboard-support', { /* editableBoolean.keyboardSupport */
  type: 'feature',
  impl: ctx => ({
		onkeydown: true,
		afterViewInit: cmp => cmp.onkeydown.filter(e=> e.keyCode == 37 || e.keyCode == 39)
			.subscribe(e=> cmp.toggle())
	})
})
