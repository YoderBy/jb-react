(function() {
var st = jb.studio;

st.ControlTree = class {
	constructor(rootPath) {
		this.rootPath = rootPath;
	}
	title(path) {
		return st.shortTitle(path)
	}
	// differnt from children() == 0, beacuse in the control tree you can drop into empty group
	isArray(path) {
		return this.children(path).length > 0;
	}
	children(path,nonRecursive) {
		return [].concat.apply([],st.controlParams(path).map(prop=>path + '~' + prop)
				.map(innerPath=>Array.isArray(st.valOfPath(innerPath)) ? st.arrayChildren(innerPath,true) : [innerPath] ))
				.concat(nonRecursive ? [] : this.innerControlPaths(path));		
	}
	move(path,draggedPath,index) {
		if (st.parentPath(draggedPath) == path)
			return st.moveInArray(path,draggedPath,index)
		else
			return st.moveInTree(path,draggedPath,index)
	}
	disabled(path) {
		return st.disabled(path)
	}
	icon(path) {
		return st.icon(path)
	}

	// private
	innerControlPaths(path) {
		// var nonControlChildren = [].concat.apply([],
		//  	st.nonControlChildren(path,true).map(innerPath=>Array.isArray(st.valOfPath(innerPath)) ? st.arrayChildren(innerPath,true) : [innerPath] ))
		// return [].concat.apply([],nonControlChildren.map(innerPath=>this.children(innerPath,true)))
		return ['action~content'] // add more inner paths here
			.map(x=>path+'~'+x)
			.filter(p=>
				st.paramTypeOfPath(p) == 'control');
	}
}

st.jbEditorTree = class {
	constructor(rootPath) {
		this.rootPath = rootPath;
	}
	title(path, collapsed) {
		var val = st.valOfPath(path);
		var compName = jb.compName(val||{});
		var prop = path.split('~').pop();
		if (!isNaN(Number(prop))) // array value - title as a[i]
			prop = path.split('~').slice(-2)
				.map(x=>x.replace(/\$pipeline/,''))
				.join('[') + ']';
		// if (Array.isArray(val) && st.paramTypeOfPath(path) == 'data')
		// 	compName = `pipeline (${val.length})`;
		// if (Array.isArray(val) && st.paramTypeOfPath(path) == 'action')
		// 	compName = `actions (${val.length})`;
		var summary = '';
		if (collapsed && typeof val == 'object')
			summary = ': ' + st.summary(path).substr(0,20);

		if (compName)
			return jb.ui.h('div',{},[prop + '= ',jb.ui.h('span',{class:'treenode-val', title: compName+summary},jb.ui.limitStringLength(compName+summary,50))]);
		else if (['string','boolean','number'].indexOf(typeof val) != -1)
			return jb.ui.h('div',{},[prop + (collapsed ? ': ': ''),jb.ui.h('span',{class:'treenode-val', title: ''+val},jb.ui.limitStringLength(''+val,50))]);

		return prop + (Array.isArray(val) ? ` (${val.length})` : '');
	}
	isArray(path) {
		return this.children(path).length > 0;
	}
	children(path) {
		var val = st.valOfPath(path);
		if (!val) return [];
		return (st.arrayChildren(path) || [])
				.concat(this.sugarChildren(path,val) || [])
				.concat(this.specialCases(path,val) || [])
				.concat(this.innerProfiles(path,val) || [])
	}
	move(path,draggedPath,index) {
		return st.moveInArray(path,draggedPath,index)
	}
	disabled(path) {
		return st.disabled(path)
	}
	icon(path) {
		return st.icon(path)
	}
	
	// private
	sugarChildren(path,val) {
		var compName = jb.compName(val);
		var sugarPath = path + '~$' +compName;
		var sugarVal = st.valOfPath(sugarPath);
		if (Array.isArray(sugarVal)) // sugar array. e.g. $pipeline: [ .. ]
			return st.arrayChildren(sugarPath);
		else if (sugarVal)
			return [sugarPath];
	}
	innerProfiles(path,val) {
		if (this.sugarChildren(path,val)) return [];
		return st.paramsOfPath(path)
			.map(p=> ({ path: path + (path.indexOf('~') == -1 ? '~impl' : '') + '~' + p.id, param: p}))
			.filter(e=>st.valOfPath(e.path) != null || e.param.essential)
			.map(e=>e.path)
	}
	specialCases(path,val) {
		if (jb.compName(val) == 'object')
			return Object.getOwnPropertyNames(val)
				.filter(p=>p!='$')
				.filter(p=>p.indexOf('$jb_') != 0)
				.map(p=>path+'~'+p);
		if (jb.compName(val) == 'if')
			return ['then','else']
		return []
	}
}


Object.assign(st,{
	jbEditorMoreParams: path =>
		st.paramsOfPath(path)
			.filter(p=>st.valOfPath(path+'~'+p.id) == null && !p.essential)
			.map(p=> path + '~' + p.id),
	nonControlChildren: (path,includeFeatures) =>
		st.paramsOfPath(path).filter(p=>!st.isControlType(p.type))
			.filter(p=>includeFeatures || p.id != 'features')
			.map(p=>path + '~' + p.id),

	arrayChildren: (path,noExtraElem) => {
		var val = st.valOfPath(path);
		if (Array.isArray(val))
			return Object.getOwnPropertyNames(val)
				.filter(x=> x.indexOf('$jb_') != 0)
				.filter(x=> !(noExtraElem && x =='length'))
				.map(x=>x=='length'? val.length : x) // extra elem
				.map(k=> path +'~'+k);
		return [];
	},
	asArrayChildren: path => { // support the case of single element - used by properties features
		var val = st.valOfPath(path);
		if (Array.isArray(val))
			return st.arrayChildren(path,true)
		else if (val)
			return [path]
	},
	isControlType: type =>
		(type||'').match(/^(control|options|menu|table-field)/),
	controlParams: path =>
		st.paramsOfPath(path).filter(p=>st.isControlType(p.type)).map(p=>p.id),

	summary: path => {
		var val = st.valOfPath(path);
		if (val == null || typeof val != 'object') return '';
		return Object.getOwnPropertyNames(val)
			.filter(p=> p != '$')
			.filter(p=> p.indexOf('$jb_') != 0)
			.map(p=>val[p])
			.filter(v=>typeof v != 'object')
			.join(', ');
	},

	shortTitle: path => {
		if (path == '') return '';
		if (path.indexOf('~') == -1)
			return path;
		if (path.match(/~impl$/))
			return path.split('~')[0];

		var val = st.valOfPath(path);
		return (val && typeof val.title == 'string' && val.title) || (val && val.remark) || (val && jb.compName(val)) || path.split('~').pop();
	},
	icon: path => {
		if (st.parentPath(path)) {
			var parentVal = st.valOfPath(st.parentPath(path));
			if (Array.isArray(parentVal) && path.split('~').pop() == parentVal.length)
				return 'add';
		}
		if (st.paramTypeOfPath(path) == 'control') {
			if (st.valOfPath(path+'~style',true) && st.compNameOfPath(path+'~style') == 'layout.horizontal')
				return 'view_column'
			return 'folder_open'; //'view_headline' , 'folder_open'
		}
		var comp2icon = { 
			label: 'font_download',
			button: 'crop_landscape',
			tab: 'tab',
			image: 'insert_photo',
			'custom-control': 'build',
			'editable-text': 'data_usage',
			'editable-boolean': 'radio_button',
			'editable-number': 'donut_large',
		}
		var compName = st.compNameOfPath(path);
		if (comp2icon[compName])
			return comp2icon[compName];

		if (st.isOfType(path,'action'))
			return 'play_arrow'

		return 'radio_button_unchecked';
	},

	// queries
	isCompNameOfType: (name,type) => {
		var _jb = st.previewjb;
		var comp = name && _jb.comps[name];
		if (comp) {
			while (_jb.comps[name] && !_jb.comps[name].type && _jb.compName(_jb.comps[name].impl))
				name = _jb.compName(_jb.comps[name].impl);
			return (_jb.comps[name] && _jb.comps[name].type || '').indexOf(type) == 0;
		}
	},
	paramDef: path => {
		if (!st.parentPath(path)) // no param def for root
			return;
		if (!isNaN(Number(path.split('~').pop()))) // array elements
			path = st.parentPath(path);
		// var parent_prof = st.valOfPath(st.parentPath(path),true);
		// var comp = parent_prof && st.getComp(jb.compName(parent_prof));
		var comp = st.compOfPath(st.parentPath(path),true);
		var params = jb.compParams(comp);
		var paramName = path.split('~').pop();
		if (paramName.indexOf('$') == 0) // sugar
			return params[0];
		return params.filter(p=>p.id==paramName)[0] || {};
	},

	isOfType: (path,type) => {
		var paramDef = st.paramDef(path);
		if (paramDef)
			return (paramDef.type || 'data').split(',')
				.map(x=>x.split('[')[0]).filter(_t=>type.split(',').indexOf(_t) != -1).length;
		return st.isCompNameOfType(st.compNameOfPath(path),type);
	},
	// single first param type
	paramTypeOfPath: path => {
		var res = ((st.paramDef(path) || {}).type || 'data').split(',')[0].split('[')[0];
		if (res == '*')
			return st.paramTypeOfPath(st.parentPath(path));
		return res;
	},
	PTsOfPath: path =>
		st.PTsOfType(st.paramTypeOfPath(path)),

	PTsOfType: type => {
		var single = /([^\[]*)([])?/;
		var types = [].concat.apply([],(type||'').split(',')
			.map(x=>
				x.match(single)[1])
			.map(x=> 
				x=='data' ? ['data','aggregator','boolean'] : [x]));
		var comp_arr = types.map(t=>
			jb.entries(st.previewjb.comps)
				.filter(c=>
					(c[1].type||'data').split(',').indexOf(t) != -1
					|| (c[1].typePattern && t.match(c[1].typePattern.match))
				)
				.map(c=>c[0]));
		return comp_arr.reduce((all,ar)=>all.concat(ar),[]);
	},

	propName: path =>{
		if (!isNaN(Number(path.split('~').pop()))) // array elements
			return st.parentPath(path).split('~').pop().replace(/s$/,'');

		var paramDef = st.paramDef(path);
		var val = st.valOfPath(path);
		if ((paramDef.type ||'').indexOf('[]') != -1) {
			var length = st.arrayChildren(path).length;
			if (length)
				return path.split('~').pop() + ' (' + length + ')';
		}

		return path.split('~').pop();
	}

})

})()