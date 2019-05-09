(function() {
var st = jb.studio;

jb.component('studio.pick', {
	type: 'action',
	params: [
		{ id: 'from', options: 'studio,preview', as: 'string', defaultValue: 'preview'},
		{ id: 'onSelect', type:'action', dynamic:true }
	],
	impl :{$: 'open-dialog',
		$vars: { pickSelection: ctx =>
      ctx.vars.pickSelection || {} },
		style: {$: 'dialog.studio-pick-dialog', from: '%$from%'},
		content: {$: 'label', title: ''}, // dummy
		onOK: ctx =>
			ctx.componentContext.params.onSelect(ctx.setData(ctx.vars.pickSelection.ctx))
	 }
})

jb.component('dialog.studio-pick-dialog', {
	hidden: true,
	type: 'dialog.style',
	params: [
		{ id: 'from', as: 'string' },
	],
	impl: {$: 'custom-style',
	      template: (cmp,state,h) => h('div',{ class: 'jb-dialog' },[
h('div',{ class: 'edge top', style: { width: state.width + 'px', top: state.top + 'px', left: state.left + 'px' }}) ,
h('div',{ class: 'edge left', style: { height: state.height +'px', top: state.top + 'px', left: state.left + 'px' }}),
h('div',{ class: 'edge right', style: { height: state.height +'px', top: state.top + 'px', left: (state.left + state.width) + 'px' }}) ,
h('div',{ class: 'edge bottom', style: { width: state.width + 'px', top: (state.top + state.height) +'px', left: state.left + 'px' }}) ,
h('div',{ class: 'title' + (state.titleBelow ? ' bottom' : ''), style: { top: state.titleTop + 'px', left: state.titleLeft + 'px'} },[
			h('div',{ class: 'text'},state.title),
			h('div',{ class: 'triangle'}),
	])]),
		css: `
>.edge {
	z-index: 6001;
	position: absolute;
	background: red;
	box-shadow: 0 0 1px 1px gray;
	width: 1px; height: 1px;
	cursor: pointer;
}
>.title {
	z-index: 6001;
	position: absolute;
	font: 14px arial; padding: 0; cursor: pointer;
	transition:top 100ms, left 100ms;
}
>.title .triangle {	width:0;height:0; border-style: solid; 	border-color: #e0e0e0 transparent transparent transparent; border-width: 6px; margin-left: 14px;}
>.title .text {	background: #e0e0e0; font: 14px arial; padding: 3px; }
>.title.bottom .triangle { background: #fff; border-color: transparent transparent #e0e0e0 transparent; transform: translateY(-28px);}
>.title.bottom .text { transform: translateY(6px);}
				`,
			features: [
				{ $: 'dialog-feature.studio-pick', from: '%$from%' },
			]
	}
})


jb.component('dialog-feature.studio-pick', {
	type: 'dialog-feature',
	params: [
		{ id: 'from', as: 'string' },
	],
	impl: ctx => ({
      init: cmp=> {
		  const _window = ctx.params.from == 'preview' ? st.previewWindow : window;
		  const previewOffset = ctx.params.from == 'preview' ? document.querySelector('#jb-preview').getBoundingClientRect().top : 0;
		  cmp.titleBelow = false;

		  const mouseMoveEm = jb.rx.Observable.fromEvent(_window.document, 'mousemove');
		  let userPick = jb.rx.Observable.fromEvent(document, 'mousedown');
		  let keyUpEm = jb.rx.Observable.fromEvent(document, 'keyup');
		  if (st.previewWindow) {
		  	userPick = userPick.merge(jb.rx.Observable.fromEvent(st.previewWindow.document, 'mousedown'));
		  	keyUpEm = keyUpEm.merge(jb.rx.Observable.fromEvent(st.previewWindow.document, 'keyup'));
		  };
		  mouseMoveEm
		  	.debounceTime(50)
		  	.takeUntil(
		  		keyUpEm.filter(e=>
		  			e.keyCode == 27)
		  			  .merge(userPick))
		  	// .do(e=>{
		  	// 	if (e.keyCode == 27)
		  	// 		ctx.vars.$dialog.close({OK:false});
		  	// })
		  	.map(e=>
		  		eventToElem(e,_window))
		  	.filter(x=>x && x.getAttribute)
		  	.do(profElem=>
            	showBox(cmp,profElem,_window,previewOffset))
        	.last() // esc or user pick
		  	.subscribe(profElem=> {
	  		    ctx.vars.pickSelection.ctx = _window.jb.ctxDictionary[profElem.getAttribute('jb-ctx')];
	  		    ctx.vars.pickSelection.elem = profElem;
		  		ctx.vars.$dialog.close({OK: true});
		  		// jb.delay(200).then(_=> {
		    //         if (st.previewWindow && st.previewWindow.getSelection())
		    //           st.previewWindow.getSelection().innerHTML = ''
		    //         })
		  	})
		}
	})
})

function pathFromElem(_window,profElem) {
	try {
		return _window.jb.ctxDictionary[profElem.getAttribute('jb-ctx') || profElem.parentElement.getAttribute('jb-ctx')].path;
	} catch (e) {
		return '';
	}
	//profElem.attr('jb-path');
}

function eventToElem(e,_window) {
	var mousePos = {
		x: e.pageX - document.body.scrollLeft, y: e.pageY - - document.body.scrollTop
	};
	var el = _window.document.elementFromPoint(mousePos.x, mousePos.y);
	if (!el) return;
	var results = [el].concat(jb.ui.parents(el))
		.filter(e =>
			e && e.getAttribute && e.getAttribute('jb-ctx') );
	if (results.length == 0) return [];

	// promote parents if the mouse is near the edge
	var first_result = results.shift(); // shift also removes first item from results!
	var edgeY = Math.max(3,Math.floor(jb.ui.outerHeight(first_result) / 10));
	var edgeX = Math.max(3,Math.floor(jb.ui.outerWidth(first_result) / 10));

	var orderedResults = results.filter(elem=>{
		return Math.abs(mousePos.y - jb.ui.offset(elem).top) < edgeY || Math.abs(mousePos.x - jb.ui.offset(elem).left) < edgeX;
	}).concat([first_result]);
	return orderedResults[0];
}

function showBox(cmp,profElem,_window,previewOffset) {
  var profElem_offset = jb.ui.offset(profElem);
	if (profElem_offset == null || jb.ui.offset(document.querySelector('#jb-preview')) == null)
		return;

	cmp.setState({
		top: previewOffset + profElem_offset.top,
		left: profElem_offset.left,
		width: jb.ui.outerWidth(profElem) == jb.ui.outerWidth(_window.document.body) ? jb.ui.outerWidth(profElem) -10 : cmp.width = jb.ui.outerWidth(profElem),
		height: jb.ui.outerHeight(profElem),
		title: st.shortTitle(pathFromElem(_window,profElem)),
		titleTop: previewOffset + profElem_offset.top - 20,
		titleLeft: profElem_offset.left
	});
}

jb.studio.getOrCreateHighlightBox = function() {
  var _window = st.previewWindow || window;
  if (!_window.document.querySelector('#preview-box')) {
    var elem = _window.document.createElement('div');
    elem.setAttribute('id','preview-box');
    !_window.document.body.appendChild(elem);
  }
  return _window.document.querySelector('#preview-box');
}

st.highlightCtx = function(ctx) {
	if (!ctx) return
	const _window = st.previewWindow || window;
	st.highlight(Array.from(_window.document.querySelectorAll(`[jb-ctx="${ctx.id}"]`)))
//		.filter(e=>e.getAttribute('jb-ctx') == ctx.id))
}

st.highlightByScriptPath = function(path) {
	const pathStr = Array.isArray(path) ? path.join('~') : path;
	const result = st.closestCtxInPreview(pathStr)
	if (result.elem)
		st.highlight([result.elem])
}


st.highlight = function(elems) {
	//var boxes = [];
	var html = elems.map(el => {
			var offset = jb.ui.offset(el);
			var width = jb.ui.outerWidth(el);
	  if (width == jb.ui.outerWidth(document.body)) width -= 10;
	  return `<div class="jbstudio_highlight_in_preview jb-fade-500ms" style="opacity: 0.5; position: absolute; background: rgb(193, 224, 228); border: 1px solid blue; zIndex: 5000;
	  width: ${width}px; left: ${offset.left}px;top: ${offset.top}px; height: ${jb.ui.outerHeight(el)}px"></div>`
	}).join('');
	var box = jb.studio.getOrCreateHighlightBox();
	jb.ui.removeClass(box,'jb-fade-3s-transition');
	box.innerHTML = html;
	jb.delay(1).then(_=> jb.ui.addClass(box,'jb-fade-3s-transition'));
	jb.delay(1000).then(_=>jb.studio.getOrCreateHighlightBox().innerHTML = ''); // clean after the fade animation
}

jb.component('studio.highlight-in-preview',{
	type: 'action',
	params: [
		{ id: 'path', as: 'string' }
	],
	impl: (ctx,path) => {
		var _window = st.previewWindow || window;
		if (!_window) return;
		var elems = Array.from(_window.document.querySelectorAll('[jb-ctx]'))
			.filter(e=>{
				var _ctx = _window.jb.ctxDictionary[e.getAttribute('jb-ctx')];
				var callerPath = _ctx && _ctx.componentContext && _ctx.componentContext.callerPath;
				return callerPath == path || (_ctx && _ctx.path == path);
			})

		if (elems.length == 0) // try to look in studio
			elems = Array.from(document.querySelectorAll('[jb-ctx]'))
			.filter(e=> {
				var _ctx = jb.ctxDictionary[e.getAttribute('jb-ctx')];
				return _ctx && _ctx.path == path
			})

		jb.studio.highlight(elems);
  }
})

st.closestCtxInPreview = _path => {
	var path = _path.split('~fields~')[0]; // field is passive..
	var _window = st.previewWindow || window;
	if (!_window) return;
	var closest,closestElem;
	var elems = Array.from(_window.document.querySelectorAll('[jb-ctx]'));
	for(var i=0;i<elems.length;i++) {
		var _ctx = _window.jb.ctxDictionary[elems[i].getAttribute('jb-ctx')];
		if (!_ctx) continue; //  || !st.isOfType(_ctx.path,'control'))
		if (_ctx.path == path)
			return {ctx: _ctx, elem: elems[i]} ;
		if (path.indexOf(_ctx.path) == 0 && (!closest || closest.path.length < _ctx.path.length)) {
			closest = _ctx; closestElem = elems[i]
		}
	}
	return {ctx: closest, elem: closestElem};
}

// st.refreshPreviewOfPath = path => {
// 	var closest = st.closestCtxInPreview(path);
// 	if (!closest.ctx) return;
// 	var closest_path = closest.ctx.path;
// 	var _window = st.previewWindow || window;
// 	Array.from(_window.document.querySelectorAll('[jb-ctx]'))
// 		.map(el=> ({el:el, ctx: _window.jb.ctxDictionary[el.getAttribute('jb-ctx')]}))
// 		.filter(elCtx => (elCtx.ctx||{}).path == closest_path )
// 		.forEach(elCtx=>{
// 			try {
// 			elCtx.ctx.profile = st.valOfPath(elCtx.ctx.path); // recalc last version of profile
// 			if (elCtx.ctx.profile)
// 				jb.ui.refreshComp(elCtx.ctx,elCtx.el);
// 			} catch(e) { jb.logException(e) };
// 		})
// }

})()
