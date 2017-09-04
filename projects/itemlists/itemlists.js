jb.resource('people',[
  { "name": "Homer Simpson" ,age: 42 , male: true, children: [{ name: 'Bart' }, { name: 'Lisa' }, { name: 'Maggie' } ]},
  { "name": "Marge Simpson" ,age: 38 , male: false, children: [{ name: 'Bart' }, { name: 'Lisa' }, { name: 'Maggie' } ]},
  { "name": "Bart Simpson"  ,age: 12 , male: true, children: []}
]);

jb.component('itemlists.main', {
  type: 'control', 
  impl :{$: 'itemlist', 
    items: '%$people%', 
    controls :{$: 'group', 
      style :{$: 'layout.horizontal', spacing: 3 }, 
      controls: [
        {$: 'label', title: '%name%' }, 
        {$: 'label', title: '%age%' }
      ]
    }
  }
})

jb.component('itemlists.table', {
  type: 'control', 
  impl :{$: 'table', 
    items: '%$people%', 
    fields: [
      {$: 'field', title: 'name', data: '%name%', width: '200' }, 
      {$: 'field', title: 'age', data: '%age%' }
    ]
  }
})

jb.component('itemlists.button-field', {
  type: 'control', 
  impl :{$: 'group', 
    title: 'button-field', 
    controls: [
      {$: 'table', 
        items: '%$people%', 
        fields: [
          {$: 'field', title: 'name', data: '%name%' }, 
          {$: 'field.button', 
            title: 'children', 
            buttonText: '%children/length%', 
            action :{$: 'open-dialog', 
              content :{$: 'group', 
                controls :{$: 'label', 
                  title :{
                    $pipeline: [
                      '%children/name%', 
                      {$: 'join', 
                        separator :{$: 'newline' }, 
                        items: '%%', 
                        itemName: 'item', 
                        itemText: '%%'
                      }
                    ]
                  }, 
                  style :{$: 'label.card-title' }
                }
              }, 
              title: 'children of %name%', 
              onOK: {  }
            }
          }
        ], 
        style :{$: 'table.with-headers' }, 
        visualSizeLimit: 100, 
        features: [{$: 'css.width', width: '300' }]
      }
    ]
  }
})

jb.component('itemlists.large-table', {
  type: 'control', 
  impl :{$: 'group', 
    title: 'large-table', 
    controls: [
      {$: 'table', 
        items :{
          $pipeline: [
            {$: 'range', from: 1, to: '1000' }, 
            {$: 'object', id: '%%', name: '%%-%%' }
          ]
        }, 
        fields: [
          {$: 'field', title: 'id', data: '%id%', numeric: true }, 
          {$: 'field', title: 'group', data: ctx => Math.floor(Number(ctx.data.id) /10) }
        ], 
        style :{$: 'table.mdl', 
          classForTable: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp', 
          classForTd: 'mdl-data-table__cell--non-numeric'
        }, 
        visualSizeLimit: '1000'
      }
    ]
  }
})

jb.component('itemlists.editable-table', {
  type: 'control', 
  impl :{$: 'group', 
    controls: [
      {$: 'table', 
        items: '%$people%', 
        fields: [
          {$: 'field.control', 
            title: '', 
            control :{$: 'material-icon', 
              icon: 'person', 
              style :{$: 'icon.material' }, 
              features :{$: 'itemlist.drag-handle' }
            }, 
            width: '60'
          }, 
          {$: 'field.control', 
            title: 'name', 
            control :{$: 'editable-text', 
              icon: 'person', 
              title: 'name', 
              databind: '%name%', 
              style :{$: 'editable-text.mdl-input-no-floating-label', width: '200' }
            }
          }, 
          {$: 'field.control', 
            title: 'age', 
            control :{$: 'editable-text', 
              icon: 'person', 
              title: 'age', 
              databind: '%age%', 
              style :{$: 'editable-text.mdl-input-no-floating-label', width: '50' }
            }
          }, 
          {$: 'field.control', 
            control :{$: 'button', 
              icon: 'delete', 
              action :{$: 'itemlist-container.delete', item: '%%' }, 
              style :{$: 'button.x', size: '21' }, 
              features :{$: 'itemlist.shown-only-on-item-hover' }
            }, 
            width: '60'
          }
        ], 
        style :{$: 'table.mdl', 
          classForTable: 'mdl-data-table mdl-shadow--2dp', 
          classForTd: 'mdl-data-table__cell--non-numeric'
        }, 
        watchItems: 'true', 
        features: [{$: 'itemlist.drag-and-drop' }]
      }, 
      {$: 'button', 
        title: 'add', 
        action :{$: 'itemlist-container.add' }, 
        style :{$: 'button.mdl-raised' }
      }
    ], 
    features :{$: 'group.itemlist-container', 
      defaultItem :{$: 'object' }
    }
  }
})

jb.component('itemlists.table-with-search', {
  type: 'control', 
  impl :{$: 'group', 
    controls: [
      {$: 'group', 
        controls: [
          {$: 'itemlist-container.search', 
            title: 'Search', 
            searchIn :{$: 'itemlist-container.search-in-all-properties' }, 
            databind: '%$itemlistCntrData/search_pattern%', 
            style :{$: 'editable-text.mdl-search' }
          }, 
          {$: 'table', 
            items :{$: 'pipeline', 
              items: [
                '%$people%', 
                {$: 'itemlist-container.filter' }
              ]
            }, 
            fields: [
              {$: 'field', title: 'name', data: '%name%' }, 
              {$: 'field', title: 'age', data: '%age%' }
            ], 
            watchItems: 'true', 
            features: [
              {$: 'watch-ref', 
                ref: '%$itemlistCntrData/search_pattern%', 
                includeChildren: ''
              }, 
              {$: 'itemlist.selection', autoSelectFirst: 'true' }, 
              {$: 'itemlist.keyboard-selection' }
            ]
          }
        ], 
        features :{$: 'group.itemlist-container' }
      }
    ]
  }
})

jb.component('itemlists.table-with-filters', {
  type: 'control', 
  impl :{$: 'group', 
    controls: [
      {$: 'group', 
        title: 'container', 
        controls: [
          {$: 'group', 
            title: 'filters', 
            style :{$: 'layout.horizontal', spacing: 45 }, 
            controls: [
              {$: 'editable-text', 
                title: 'name', 
                databind: '%$itemlistCntrData/name_filter%', 
                style :{$: 'editable-text.mdl-input', width: '100' }, 
                features :{$: 'itemlist-container.filter-field', 
                  fieldData: '%name%', 
                  filterType :{$: 'filter-type.text', ignoreCase: true }
                }
              }, 
              {$: 'editable-text', 
                title: 'age', 
                databind: '%$itemlistCntrData/age_filter%', 
                style :{$: 'editable-text.mdl-input', width: '100' }, 
                features :{$: 'itemlist-container.filter-field', 
                  fieldData: '%age%', 
                  filterType :{$: 'filter-type.numeric' }
                }
              }
            ]
          }, 
          {$: 'table', 
            items :{$: 'pipeline', 
              items: [
                '%$people%', 
                {$: 'itemlist-container.filter' }
              ]
            }, 
            fields: [
              {$: 'field', title: 'name', data: '%name%', width: '200' }, 
              {$: 'field', title: 'age', data: '%age%' }
            ], 
            watchItems: 'true', 
            features :{$: 'watch-ref', ref: '%$itemlistCntrData%', includeChildren: 'true' }
          }
        ], 
        features :{$: 'group.itemlist-container' }
      }
    ]
  }
})
