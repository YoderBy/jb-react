import { h, render, Component } from 'preact';
import update from 'immutability-helper';

var ui = jb.ui;

function ctrl(context,options) {
	var ctx = context.setVars({ $model: context.params });
	var styleOptions = defaultStyle(ctx);
	if (styleOptions.jbExtend)  {// style by control
		styleOptions.ctxForPick = ctx;
		return styleOptions.jbExtend(options).applyFeatures(ctx);
	}
	return new JbComponent(ctx).jbExtend(options).jbExtend(styleOptions).applyFeatures(ctx); 

	function defaultStyle(ctx) {
		var profile = context.profile;
		var defaultVar = '$theme.' + (profile.$ || '');
		if (!profile.style && context.vars[defaultVar])
			return ctx.run({$:context.vars[defaultVar]})
		return context.params.style(ctx);
	}
}

var cssId = 0;
var cssSelectors_hash = {};

class JbComponent {
	constructor(ctx) {
		this.ctx = ctx;
		Object.assign(this, {jbInitFuncs: [], jbBeforeInitFuncs: [], jbRegisterEventsFuncs:[], jbAfterViewInitFuncs: [],
			jbCheckFuncs: [],jbDestroyFuncs: [], extendCtxFuncs: [], modifierFuncs: [], extendItemFuncs: [] });
		this.cssSelectors = [];

		this.jb_profile = ctx.profile;
		var title = jb.tosingle(jb.val(this.ctx.params.title)) || (() => ''); 
		this.jb_title = (typeof title == 'function') ? title : () => ''+title;
		this.jb$title = (typeof title == 'function') ? title() : title; // for debug
	}

	reactComp() {
		var jbComp = this;
		class ReactComp extends Component {
			constructor(props) {
				super();
				this.jbComp = jbComp;
				this.ctx = jbComp.ctx;
				this.destroyed = new Promise(resolve=>this.resolveDestroyed = resolve);
				try {
					if (jbComp.createjbEmitter)
						this.jbEmitter = this.jbEmitter || new jb.rx.Subject();
		    		this.refreshCtx = _ => {
						jbComp.extendCtxFuncs.forEach(extendCtx => {
			    			this.ctx = extendCtx(this.ctx,this);
			    		})
			    		return this.ctx;
			    	}
			    	this.refreshCtx();
					Object.assign(this,(jbComp.styleCtx || {}).params);
					jbComp.jbBeforeInitFuncs.forEach(init=> init(this,props));
					jbComp.jbInitFuncs.forEach(init=> init(this,props));
			    } catch(e) { jb.logException(e,'') }
			}
			render(props,state) {
				var vdom = jbComp.template(this,state,ui.h);
				jbComp.modifierFuncs.forEach(modifier=> vdom = modifier(vdom,this,state) || vdom);
				return vdom;
			}
    		componentDidMount() {
				jbComp.injectCss(this);
				jbComp.jbRegisterEventsFuncs.forEach(init=> init(this));
				jbComp.jbAfterViewInitFuncs.forEach(init=> init(this));
				if (this.jbEmitter)
					this.jbEmitter.next('after-init');
			}
	  		componentWillUnmount() {
				jbComp.jbDestroyFuncs.forEach(f=> 
					f(this));
				if (this.jbEmitter) {
					 this.jbEmitter.next('destroy');
					 this.jbEmitter.complete();
				}
				this.resolveDestroyed();
			}
		}; 
		injectLifeCycleMethods(ReactComp,this);
		ReactComp.ctx = this.ctx;
		ReactComp.title = this.jb_title();
		return ReactComp;
	}

	compileJsx() {
		// todo: compile template if string - cache result
	}

	injectCss(cmp) {
		var elem = cmp.base;
		var ctx = this.ctx;
	  	while (ctx.profile.__innerImplementation)
	  		ctx = ctx.componentContext._parent;
	  	var attachedCtx = this.ctxForPick || ctx;
	  	elem.setAttribute('jb-ctx',attachedCtx.id);
		garbageCollectCtxDictionary();
		jb.ctxDictionary[attachedCtx.id] = attachedCtx;

		if (this.cssSelectors && this.cssSelectors.length > 0) {
			var cssKey = this.cssSelectors.join('\n');
			if (!cssSelectors_hash[cssKey]) {
				cssId++;
				cssSelectors_hash[cssKey] = cssId;
				var cssStyle = this.cssSelectors.map(x=>`.jb-${cssId}${x}`).join('\n');
				var remark = `/*style: ${ctx.profile.style && ctx.profile.style.$}, path: ${ctx.path}*/\n`;
				$(`<style type="text/css">${remark}${cssStyle}</style>`).appendTo($('head'));
			}
			elem.classList.add(`jb-${cssSelectors_hash[cssKey]}`);
		}
	}

	applyFeatures(context) {
		var features = (context.params.features && context.params.features(context) || []);
		features.forEach(f => this.jbExtend(f,context));
		if (context.params.style && context.params.style.profile && context.params.style.profile.features) {
			jb.toarray(context.params.style.profile.features)
				.forEach((f,i)=>
					this.jbExtend(context.runInner(f,{type:'feature'},context.path+'~features~'+i),context))
		}
		return this;
	}

	jbExtend(options,context) {
    	if (!options) return this;
    	context = context || this.ctx;
    	if (!context)
    		console.log('no context provided for jbExtend');
    	if (typeof options != 'object')
    		debugger;

    	this.template = this.template || options.template;

		if (options.beforeInit) this.jbBeforeInitFuncs.push(options.beforeInit);
		if (options.init) this.jbInitFuncs.push(options.init);
		if (options.afterViewInit) this.jbAfterViewInitFuncs.push(options.afterViewInit);
		if (options.doCheck) this.jbCheckFuncs.push(options.doCheck);
		if (options.destroy) this.jbDestroyFuncs.push(options.destroy);
		if (options.templateModifier) this.modifierFuncs.push(options.templateModifier);
		if (typeof options.class == 'string') 
			this.modifierFuncs.push(vdom=> ui.addClassToVdom(vdom,options.class));
		if (typeof options.class == 'function') 
			this.modifierFuncs.push(vdom=> ui.addClassToVdom(vdom,options.class()));
		// events
		var events = Object.getOwnPropertyNames(options).filter(op=>op.indexOf('on') == 0);
		events.forEach(op=>
			this.jbRegisterEventsFuncs.push(cmp=>
		       	  cmp[op] = cmp[op] || jb.rx.Observable.fromEvent(cmp.base, op.slice(2))
		       	  	.takeUntil( cmp.destroyed )));

		if (options.jbEmitter || events.length > 0) this.createjbEmitter = true;
		if (options.ctxForPick) this.ctxForPick=options.ctxForPick;
		if (options.extendCtx) 
			this.extendCtxFuncs.push(options.extendCtx);
		if (options.extendItem) 
			this.extendItemFuncs.push(options.extendItem);
		this.styleCtx = this.styleCtx || options.styleCtx;

	   	if (options.css)
    		this.cssSelectors = (this.cssSelectors || [])
    			.concat(options.css.split(/}\s*/m)
    				.map(x=>x.trim())
    				.filter(x=>x)
    				.map(x=>x+'}')
    				.map(x=>x.replace(/^!/,' '))
    			);

		(options.featuresOptions || []).forEach(f => 
			this.jbExtend(f, context))
		return this;
	}
}

function injectLifeCycleMethods(Comp,jbComp) {
	if (jbComp.jbCheckFuncs.length)
	  Comp.prototype.componentWillUpdate = function() {
		jbComp.jbCheckFuncs.forEach(f=> 
			f(this));
//		this.refreshModel && this.refreshModel();
//		this.jbEmitter && this.jbEmitter.next('check');
	}
	if (jbComp.createjbEmitter)
	  Comp.prototype.componentDidUpdate = function() {
		this.jbEmitter.next('after-update');
	}
}

function garbageCollectCtxDictionary() {
	var now = new Date().getTime();
	ui.ctxDictionaryLastCleanUp = ui.ctxDictionaryLastCleanUp || now;
	var timeSinceLastCleanUp = now - ui.ctxDictionaryLastCleanUp;
	if (timeSinceLastCleanUp < 10000) 
		return;
	ui.ctxDictionaryLastCleanUp = now;

	var used = Array.from(document.querySelectorAll('[jb-ctx]')).map(e=>Number(e.getAttribute('jb-ctx'))).sort((x,y)=>x-y);
	var dict = Object.getOwnPropertyNames(jb.ctxDictionary).map(x=>Number(x)).sort((x,y)=>x-y);
	var lastUsedIndex = 0;
	for(var i=0;i<dict.length;i++) {
		while (used[lastUsedIndex] < dict[i])
			lastUsedIndex++;
		if (used[lastUsedIndex] > dict[i])
			delete jb.ctxDictionary[''+dict[i]];
	}
}

ui.focus = function(elem,logTxt) {
    if (jb.studio.lastStudioActivity && new Date().getTime() - jb.studio.lastStudioActivity < 1000)
    	return;
    jb.logPerformance('focus',logTxt);
    jb.delay(1).then(_=>
    	elem.focus())
}

ui.wrapWithLauchingElement = (f,context,elem) => 
	_ =>
		f(context.setVars({ $launchingElement: { $el : $(elem) }}));


// ****************** data binding

ui.pathId = 0;
ui.resourceVersions = {}

ui.writeValue = (to,value) => {
  if (!to) 
  	return jb.logError('writeValue: empty "to"');

  if (to.$jb_parent && to.$jb_parent[to.$jb_property] === jb.val(value)) return;

  if (to.$jb_val) // will handle the change by iteself 
    return to.$jb_val(jb.val(value));

  if (to.$jb_parent) {
  	var res = ui.pathOfObject(to.$jb_parent,ui.resources);
  	if (res) {
  		var op = {}, resource = res[0], path = res.concat([to.$jb_property]);
  		jb.path(op,path,{$set: value});
  		ui.resources = ui.update(ui.resources,op);
  		ui.resourceVersions[resource] = ui.resourceVersions[resource] ? ui.resourceVersions[resource]+1 : 1;
  		ui.resourceChange.next({op: op, path: path});
  	} else {
  		jb.logError('writeValue: can not find parent in resources');
    	to.$jb_parent[to.$jb_property] = jb.val(value);
    }
  }
}

ui.splice = function(arr,args) {
  	var res = ui.pathOfObject(arr,ui.resources);
  	if (res) {
  		var op = {}, resource = res[0], path = res;
  		jb.path(op,path,{$splice: args });
  		ui.resources = ui.update(ui.resources,op);
  		ui.resourceVersions[resource] = ui.resourceVersions[resource] ? ui.resourceVersions[resource]+1 : 1;
  		ui.resourceChange.next({op: op, path: path});
  	} else {
  		jb.logError('splice: can not find parent in resources');
    }
}

ui.refOfObj = function(obj) {
  	var res = ui.findPath(obj,ui.resources);
  	if (res) 
  		return Object.assign(res,{ 
  			$jb_property: res.$jb_path[res.$jb_path.length-1],
  			$jb_resourceV: ui.resourceVersions[res.$jb_path[0]]
  		})
}

ui.refObservable = function(ref,cmp) {
  if (!ref) 
  	return jb.rx.Observable.of();
  if (ref.$jb_parent) {
  	ui.updateJbParent(ref);
  	return ui.resourceChange
  		.takeUntil(cmp.destroyed)
  		.filter(e=>
  			e.path.join('~').indexOf((ref.$jb_path||[]).join('~')) == 0)
  		.map(_=>
  			jb.val(ref))
  		.distinctUntilChanged()
  }
  return jb.rx.Observable.of(jb.val(ref));
}

ui.updateJbParent = function(ref) {
	if (! ref.$jb_path) { // first time - look in all resources
		var found = ui.findPath(ref.$jb_parent,ui.resources);
	} else { 
		var resource = ref.$jb_path[0];
		if (ref.$jb_resourceV == ui.resourceVersions[resource]) return;

		var found = ui.findPath(ref.$jb_parent,ui.resources[resource]);
		if (found)
			found.$jb_path = [resource].concat(found.$jb_path);
	}

	if (found) {
		Object.assign(ref,found);
		ref.$jb_resourceV = ui.resourceVersions[ref.$jb_path[0]];
	} 
}

ui.findPath = function(obj,lookIn) {
	if (!lookIn || typeof lookIn != 'object') 
		return;
	if ((lookIn.$jb_id && lookIn.$jb_id === obj.$jb_id) || lookIn === obj)
		return { $jb_path: [], $jb_parent: lookIn};
	for(var p in lookIn) {
		var res = ui.findPath(obj,lookIn[p]);
		if (res) {
			res.$jb_path = [p].concat(res.$jb_path);
			return res;
		}
	}
}

ui.pathOfObject = function(obj,lookIn) {
	if (typeof lookIn != 'object') 
		return;
	if (lookIn.$jb_id && lookIn.$jb_id === obj.$jb_id) 
		return [];
	if (lookIn === obj) {
		lookIn.$jb_id = ++ui.pathId;
		return [];
	}
	for(var p in lookIn) {
		var res = ui.pathOfObject(obj,lookIn[p]);
		if (res) 
			return [p].concat(res);
	}
}

// ****************** generic utils ***************

if (typeof $ != 'undefined' && $.fn)
    $.fn.findIncludeSelf = function(selector) { 
    	return this.find(selector).addBack(selector); }  

ui.renderWidget = function(profile,elem) {
	ui.render(ui.h(new jb.jbCtx().run(profile).reactComp()),elem);
	ui.widgetLoaded = true;
}
ui.applyAfter = function(promise,ctx) {
	// should refresh all after promise
}

jb.ui.waitFor = function(check,times,interval) {
  if (check())
    return Promise.resolve(1);

  times = times || 300;
  interval = interval || 50;

  return new Promise((resolve,fail)=>{
    function wait_and_check(counter) {
      if (counter < 1)
        fail();
      setTimeout(() => {
        if (check())
          resolve();
        else
          wait_and_check(counter-1)
      }, interval);  
    }
    return wait_and_check(times);
  })
}

// ****************** vdom utils ***************

ui.addClassToVdom = function(vdom,clz) {
	vdom.attributes = vdom.attributes || {};
	vdom.attributes.class = [vdom.attributes.class,clz].filter(x=>x).join(' ');
	return vdom;
}

ui.toggleClassInVdom = function(vdom,clz,add) {
  vdom.attributes = vdom.attributes || {};
  var classes = (vdom.attributes.class || '').split(' ').map(x=>x.trim()).filter(x=>x);
  if (add && classes.indexOf(clz) == -1)
    vdom.attributes.class = classes.concat([clz]).join(' ');
  if (!add)
    vdom.attributes.class = classes.filter(x=>x==clz).join(' ');
  return vdom;
}

ui.item = function(cmp,ctrl,vdom) {
	cmp.jbComp.extendItemFuncs.forEach(f=>f(cmp,ctrl,vdom));
	return vdom;
}

// ****************** components ****************

jb.component('custom-style', {
	typePattern: /.*-style/,
	params: [
		{ id: 'template', as: 'single', essential: true, dynamic: true, ignore: true },
		{ id: 'css', as: 'string' },
    	{ id: 'features', type: 'feature[]', dynamic: true },
	],
	impl: (context,css,features) => ({
		template: context.profile.template,
		css: css,
		featuresOptions: features(),
		styleCtx: context._parent
	})
})

jb.component('style-by-control', {
	typePattern: /.*-style/,
	params: [
		{ id: 'control', type: 'control', essential: true, dynamic: true },
		{ id: 'modelVar', as: 'string', essential: true }
	],
	impl: (ctx,control,modelVar) =>
		control(ctx.setVars( jb.obj(modelVar,ctx.vars.$model)))
})

ui.ctrl = ctrl;
ui.render = render;
ui.h = h;
ui.Component = Component;
ui.update = update;
ui.resourceChange = new jb.rx.Subject();
