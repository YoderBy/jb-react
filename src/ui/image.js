jb.component('image', {
	type: 'control,image', category: 'control:50',
	params: [
		{ id: 'url', as: 'string', mandatory: true },
		{ id: 'imageWidth', as: 'number' },
		{ id: 'imageHeight', as: 'number' },
		{ id: 'width', as: 'number' },
		{ id: 'height', as: 'number' },
		{ id: 'units', as: 'string', defaultValue : 'px'},
		{ id: 'style', type: 'image.style', dynamic: true, defaultValue: { $: 'image.default' } },
		{ id: 'features', type: 'feature[]', dynamic: true }
	],
	impl: ctx => {
			['imageWidth','imageHeight','width','height'].forEach(prop=>
					ctx.params[prop] = ctx.params[prop] || null);
			return jb.ui.ctrl(ctx, {
				init: cmp =>
					cmp.state.url = ctx.params.url
			})
		}
})

jb.component('image.default', {
	type: 'image.style',
	impl :{$: 'custom-style',
		template: (cmp,state,h) =>
			h('div',{}, h('img', {src: state.url})),

		css: `{ {? width: %$$model/width%%$$model/units%; ?} {? height: %$$model/height%%$$model/units%; ?} }
			>img{ {? width: %$$model/imageWidth%%$$model/units%; ?} {? height: %$$model/imageHeight%%$$model/units%; ?} }`
	}
})
