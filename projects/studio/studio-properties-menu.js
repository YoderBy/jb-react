jb.component('studio.open-property-menu', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'menu.open-context-menu',
    menu :{$: 'menu.menu',
		$vars: {
	      compName :{$: 'studio.comp-name', path: '%$path%' }
	    },
      options: [
        {$: 'studio.style-editor-options', path: '%$path%' },
        {$: 'menu.action',
          title: 'multiline edit',
          action :{$: 'studio.open-multiline-edit', path: '%$path%' },
          showCondition :{$: 'equals',
            item1 :{ $pipeline: [{$: 'studio.param-def', path: '%$path%' }, '%as%'] },
            item2: 'string'
          }
        },
        {$: 'menu.action',
          title: 'Goto %$compName%',
          action :{$: 'studio.goto-path', path: '%$compName%' },
          showCondition: '%$compName%'
        },
        {$: 'menu.action',
          title: 'Inteliscript editor',
          action :{$: 'studio.open-jb-editor', path: '%$path%' },
          shortcut: 'Ctrl+I',
          icon: 'code'
        },
        {$: 'menu.action',
          title: 'Javascript editor',
          action :{$: 'studio.edit-source', path: '%$path%' },
          icon: 'code',
          shortcut: 'Ctrl+J'
        },
        {$: 'studio.goto-editor-options', path: '%$path%' },
        {$: 'menu.action',
          title: 'Delete',
          action :{$: 'studio.delete', path: '%$path%' },
          icon: 'delete',
          shortcut: 'Delete'
        },
        {$: 'menu.action',
          title :{
            $if :{$: 'studio.disabled', path: '%$path%' },
            then: 'Enable',
            else: 'Disable'
          },
          action :{$: 'studio.toggle-disabled', path: '%$path%' },
          icon: 'do_not_disturb',
          shortcut: 'Ctrl+X'
        }
      ]
    }
  }
})
