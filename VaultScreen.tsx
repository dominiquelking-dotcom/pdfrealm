import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Linking,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { apiGet, BASE_URL, getToken } from '../api';

type VaultFile = {
  id: string;
  filename: string;
  name?: string;
  sizeBytes?: number;
  bytes?: number;
  size?: number;
  createdAt?: string;
  lastModified?: string;
  mimeType?: string;
};

type VaultFolder = { id?: string; name: string; path: string };

function fmtBytes(n: number) {
  if (!n) return '';
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function fileIcon(filename: string) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return '📄';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return '🖼️';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx'].includes(ext)) return '📊';
  if (ext === 'zip') return '🗜️';
  return '📎';
}

function getFileName(f: VaultFile): string {
  return f.filename || f.name || 'Unknown';
}

function getFileSize(f: VaultFile): number {
  return f.sizeBytes ?? f.bytes ?? f.size ?? 0;
}

function getFileDate(f: VaultFile): string {
  const d = f.createdAt || f.lastModified;
  if (!d) return '';
  return new Date(d).toLocaleDateString();
}

export default function VaultScreen() {
  const [currentFolder, setCurrentFolder] = useState('');
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [search, setSearch] = useState('');

  const loadVault = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const data = await apiGet(`/api/vault/list?folder=${encodeURIComponent(currentFolder)}`);
      // API returns { items: [...], folders: [...] }
      const rawItems: VaultFile[] = data.items || data.files || [];
      const rawFolders: string[] = data.folders || [];
      setFiles(rawItems);
      // folders is array of path strings; convert to objects
      setFolders(
        rawFolders
          .filter((p: string) => {
            // Only show folders that are direct children of currentFolder
            if (!currentFolder) {
              return !p.includes('/');
            }
            const rel = p.startsWith(currentFolder + '/') ? p.slice(currentFolder.length + 1) : null;
            return rel !== null && !rel.includes('/');
          })
          .map((p: string) => ({
            path: p,
            name: p.split('/').pop() || p,
          }))
      );
    } catch (e: any) {
      setMsg(e.message || 'Failed to load vault');
    } finally {
      setLoading(false);
    }
  }, [currentFolder]);

  useEffect(() => {
    loadVault();
  }, [loadVault]);

  const uploadFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      setUploading(true);
      setMsg('Uploading...');
      const token = await getToken();
      const form = new FormData();
      form.append('file', {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType || 'application/octet-stream',
      } as any);
      form.append('folderPath', currentFolder || 'Mobile Uploads');
      const res = await fetch(`${BASE_URL}/api/vault/upload`, {
        method: 'POST',
        headers: { Authorization: token ? `Bearer ${token}` : '' },
        body: form,
      });
      const data = await res.json();
      if (data.ok) {
        setMsg('Uploaded successfully!');
        loadVault();
      } else {
        setMsg(data.error || 'Upload failed');
      }
    } catch (e: any) {
      setMsg(e.message || 'Upload error');
    } finally {
      setUploading(false);
    }
  };

  const downloadFile = async (file: VaultFile) => {
    try {
      const data = await apiGet(`/api/vault/presign?id=${encodeURIComponent(file.id)}`);
      const url = data.url || data.downloadUrl;
      if (url) {
        Linking.openURL(url);
      } else {
        Alert.alert('Error', 'No download URL returned');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const deleteFile = async (file: VaultFile) => {
    Alert.alert('Delete', `Delete "${getFileName(file)}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const token = await getToken();
            await fetch(`${BASE_URL}/api/vault/item/${encodeURIComponent(file.id)}`, {
              method: 'DELETE',
              headers: { Authorization: token ? `Bearer ${token}` : '' },
            });
            loadVault();
          } catch (e: any) {
            Alert.alert('Error', e.message);
          }
        },
      },
    ]);
  };

  const navigateFolder = (folderPath: string) => {
    setCurrentFolder(folderPath);
    setSearch('');
  };

  const navigateUp = () => {
    const parts = currentFolder.split('/').filter(Boolean);
    parts.pop();
    setCurrentFolder(parts.join('/'));
    setSearch('');
  };

  const filteredFiles = files.filter((f) => {
    if (!search) return true;
    const name = getFileName(f).toLowerCase();
    return name.includes(search.toLowerCase());
  });

  type ListItem =
    | (VaultFolder & { _type: 'folder' })
    | (VaultFile & { _type: 'file' });

  const listData: ListItem[] = [
    ...folders.map((f) => ({ ...f, _type: 'folder' as const })),
    ...filteredFiles.map((f) => ({ ...f, _type: 'file' as const })),
  ];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {currentFolder ? (
            <TouchableOpacity onPress={navigateUp} style={styles.backBtn}>
              <Text style={styles.backText}>‹ Back</Text>
            </TouchableOpacity>
          ) : null}
          <Text style={styles.headerTitle} numberOfLines={1}>
            {currentFolder ? currentFolder.split('/').pop() : '🗄️ Vault'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.uploadBtn, uploading && styles.btnDisabled]}
          onPress={uploadFile}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.uploadBtnText}>⬆ Upload</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Breadcrumb */}
      {currentFolder ? (
        <View style={styles.breadcrumb}>
          <TouchableOpacity onPress={() => navigateFolder('')}>
            <Text style={styles.crumbLink}>Vault</Text>
          </TouchableOpacity>
          {currentFolder.split('/').filter(Boolean).map((part, i, arr) => (
            <React.Fragment key={i}>
              <Text style={styles.crumbSep}> / </Text>
              <TouchableOpacity onPress={() => navigateFolder(arr.slice(0, i + 1).join('/'))}>
                <Text style={styles.crumbLink}>{part}</Text>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>
      ) : null}

      {/* Search */}
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          placeholder="🔍 Search files..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {msg ? <Text style={styles.msg}>{msg}</Text> : null}

      {loading ? (
        <ActivityIndicator color="#3b82f6" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item, i) => item._type + i + (item._type === 'file' ? item.id : item.path)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadVault} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {search
                ? 'No files match your search.'
                : 'Vault is empty. Upload your first file!'}
            </Text>
          }
          renderItem={({ item }) => {
            if (item._type === 'folder') {
              return (
                <TouchableOpacity style={styles.row} onPress={() => navigateFolder(item.path)}>
                  <Text style={styles.icon}>📁</Text>
                  <Text style={[styles.name, { flex: 1 }]}>{item.name}</Text>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            }
            const f = item as VaultFile & { _type: 'file' };
            return (
              <View style={styles.row}>
                <Text style={styles.icon}>{fileIcon(getFileName(f))}</Text>
                <View style={styles.fileInfo}>
                  <Text style={styles.name} numberOfLines={1}>
                    {getFileName(f)}
                  </Text>
                  <Text style={styles.meta}>
                    {[fmtBytes(getFileSize(f)), getFileDate(f)].filter(Boolean).join('  ·  ')}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => downloadFile(f)} style={styles.actionBtn}>
                  <Text style={styles.actionText}>⬇️</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => deleteFile(f)} style={styles.actionBtn}>
                  <Text style={[styles.actionText, { color: '#ef4444' }]}>🗑️</Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    backgroundColor: '#1e40af',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  headerRow: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 12 },
  backBtn: { marginRight: 8 },
  backText: { color: '#93c5fd', fontSize: 16, fontWeight: '600' },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#fff', flex: 1 },
  uploadBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnDisabled: { opacity: 0.6 },
  uploadBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  breadcrumb: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
  },
  crumbLink: { color: '#1d4ed8', fontSize: 13, fontWeight: '600' },
  crumbSep: { color: '#6b7280', fontSize: 13 },
  searchWrap: { padding: 12, paddingBottom: 4 },
  searchInput: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    fontSize: 14,
    color: '#0f172a',
  },
  msg: { color: '#059669', textAlign: 'center', marginHorizontal: 16, marginBottom: 4, fontSize: 13 },
  list: { padding: 12, paddingTop: 8, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  icon: { fontSize: 22, marginRight: 10 },
  fileInfo: { flex: 1 },
  name: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
  meta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  chevron: { color: '#94a3b8', fontSize: 22, fontWeight: '300' },
  actionBtn: { padding: 6, marginLeft: 2 },
  actionText: { fontSize: 18 },
  emptyText: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 15,
    marginTop: 40,
    paddingHorizontal: 32,
  },
});
